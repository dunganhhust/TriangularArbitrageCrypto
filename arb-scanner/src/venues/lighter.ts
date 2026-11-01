import { normalize } from "../book.js";
import type { Book, Funding, Level, Log, Venue, VenueFees } from "../types.js";
import { ReconnectingWs } from "../ws.js";

/**
 * UNVERIFIED against the live API (written from the public docs): the probe command prints the raw messages so the
 * parsers can be checked. Expected: {type:"subscribed/order_book"|"update/order_book", channel:"order_book:<id>",
 * order_book:{asks:[{price,size}], bids:[{price,size}]}}. A size of 0 removes a level; the first message is a snapshot.
 */
export class LighterBookState {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  /** Apply a message; returns true when it was an order-book message. */
  apply(m: { type?: string; order_book?: { asks?: { price: string; size: string }[]; bids?: { price: string; size: string }[] } }): boolean {
    if (!m.order_book || !m.type?.endsWith("order_book")) return false;
    if (m.type.startsWith("subscribed")) {
      this.bids.clear();
      this.asks.clear();
    }
    const put = (map: Map<number, number>, ls?: { price: string; size: string }[]) => {
      for (const l of ls ?? []) {
        const p = Number(l.price);
        const s = Number(l.size);
        if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
        if (s > 0) map.set(p, s);
        else map.delete(p);
      }
    };
    put(this.bids, m.order_book.bids);
    put(this.asks, m.order_book.asks);
    return true;
  }

  toBook(ts: number): Book {
    const lv = (m: Map<number, number>): Level[] => [...m].map(([price, size]) => ({ price, size }));
    return normalize(lv(this.bids), lv(this.asks), ts);
  }
}

/** /api/v1/orderBooks answer: {order_books:[{symbol, market_id, ...}]}. */
export function parseLighterMarkets(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rows = (body as { order_books?: { symbol?: string; market_id?: number }[] })?.order_books ?? [];
  for (const r of rows) if (r.symbol && typeof r.market_id === "number") out.set(r.symbol, r.market_id);
  return out;
}

/** /api/v1/funding-rates answer: {funding_rates:[{market_id, exchange, symbol, rate}]}; keep this venue's own rows. */
export function parseLighterFunding(body: unknown, ts: number, hoursPerRate = 1): Map<string, Funding> {
  const out = new Map<string, Funding>();
  const rows = (body as { funding_rates?: { symbol?: string; exchange?: string; rate?: number | string }[] })?.funding_rates ?? [];
  for (const r of rows) {
    if (r.exchange && r.exchange !== "lighter") continue;
    const rate = Number(r.rate);
    if (r.symbol && Number.isFinite(rate)) out.set(r.symbol, { ratePerHour: rate / hoursPerRate, ts });
  }
  return out;
}

export class Lighter implements Venue {
  readonly name = "lighter";
  readonly fees: VenueFees;
  samples: string[] = [];
  private state = new Map<number, LighterBookState>();
  private books = new Map<number, Book>();
  private ids = new Map<string, number>();
  private fund = new Map<string, Funding>();
  private ws: ReconnectingWs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private active: string[] = [];

  constructor(
    private readonly log: Log,
    fees: VenueFees = { makerBps: 0, takerBps: 0 },
    private readonly url = "https://mainnet.zklighter.elliot.ai",
    private readonly symbolMap: Record<string, string> = {},
    private readonly fundingHoursPerRate = 1,
  ) {
    this.fees = fees;
  }

  async start(symbols: string[]): Promise<void> {
    const r = await fetch(this.url + "/api/v1/orderBooks");
    if (!r.ok) throw new Error(`lighter orderBooks HTTP ${r.status}`);
    const markets = parseLighterMarkets(await r.json());
    this.active = symbols.filter((s) => markets.has(this.symbolMap[s] ?? s));
    for (const s of this.active) this.ids.set(s, markets.get(this.symbolMap[s] ?? s)!);
    await this.pollFunding().catch((e) => this.log("lighter funding failed", { error: String(e) }));
    this.timer = setInterval(() => void this.pollFunding().catch(() => {}), 60_000);
    const byId = new Map([...this.ids].map(([s, id]) => [id, s]));
    this.ws = new ReconnectingWs({
      url: this.url.replace(/^http/, "ws") + "/stream",
      log: this.log,
      staleMs: 20_000,
      onOpen: (send) => {
        this.state.clear();
        for (const id of byId.keys()) send({ type: "subscribe", channel: `order_book/${id}` });
      },
      onMessage: (raw) => {
        if (this.samples.length < 5) this.samples.push(raw.slice(0, 600));
        let m: { type?: string; channel?: string; order_book?: unknown };
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.type === "ping") return;
        const id = Number(String(m.channel ?? "").split(/[:/]/)[1]);
        if (!byId.has(id)) return;
        const st = this.state.get(id) ?? new LighterBookState();
        this.state.set(id, st);
        if (st.apply(m as Parameters<LighterBookState["apply"]>[0])) this.books.set(id, st.toBook(Date.now()));
      },
    });
    this.ws.start();
  }

  stop(): void {
    this.ws?.stop();
    if (this.timer) clearInterval(this.timer);
  }

  private async pollFunding(): Promise<void> {
    const r = await fetch(this.url + "/api/v1/funding-rates");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const [k, v] of parseLighterFunding(await r.json(), Date.now(), this.fundingHoursPerRate)) this.fund.set(k, v);
  }

  book(symbol: string): Book | null {
    const id = this.ids.get(symbol);
    return id === undefined ? null : (this.books.get(id) ?? null);
  }
  funding(symbol: string): Funding | null {
    return this.fund.get(this.symbolMap[symbol] ?? symbol) ?? null;
  }
  symbols(): string[] {
    return this.active;
  }
}
