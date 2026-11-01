import { normalize } from "../book.js";
import type { Book, Funding, Log, Venue, VenueFees } from "../types.js";
import { ReconnectingWs } from "../ws.js";

/**
 * Aster futures (Binance-futures-compatible). From the public docs, not yet checked against the live API.
 * Partial depth stream `<symbol>@depth<N>@100ms`: {"e":"depthUpdate","s":"ETHUSDT","b":[[px,qty]...],"a":[[px,qty]...]}, a
 * snapshot of the top N levels. Combined streams wrap it as {"stream":"...","data":{...}}.
 */
export function parseAsterDepth(raw: string, ts: number): { symbol: string; book: Book } | null {
  let m: { data?: unknown; s?: string; b?: string[][]; a?: string[][]; stream?: string };
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  const d = (m.data ?? m) as { s?: string; b?: string[][]; a?: string[][] };
  if (!d.s || !Array.isArray(d.b) || !Array.isArray(d.a)) return null;
  const conv = (ls: string[][]) => ls.map((l) => ({ price: Number(l[0]), size: Number(l[1]) }));
  return { symbol: d.s, book: normalize(conv(d.b), conv(d.a), ts) };
}

/** premiumIndex rows -> funding per hour, given each symbol's funding interval in hours (default 8). */
export function parseAsterFunding(premium: unknown, intervals: Map<string, number>, ts: number): Map<string, Funding> {
  const out = new Map<string, Funding>();
  const rows = Array.isArray(premium) ? premium : premium ? [premium] : [];
  for (const r of rows as { symbol?: string; lastFundingRate?: string }[]) {
    const rate = Number(r.lastFundingRate);
    if (r.symbol && Number.isFinite(rate)) out.set(r.symbol, { ratePerHour: rate / (intervals.get(r.symbol) ?? 8), ts });
  }
  return out;
}

export function parseAsterIntervals(info: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of (Array.isArray(info) ? info : []) as { symbol?: string; fundingIntervalHours?: number }[]) if (r.symbol && r.fundingIntervalHours) out.set(r.symbol, r.fundingIntervalHours);
  return out;
}

export class Aster implements Venue {
  readonly name = "aster";
  readonly fees: VenueFees;
  samples: string[] = [];
  private books = new Map<string, Book>();
  private fund = new Map<string, Funding>();
  private ws: ReconnectingWs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private active: string[] = [];

  constructor(
    private readonly log: Log,
    /** Not in the docs we could read: set the real tier in the config. */
    fees: VenueFees = { makerBps: 1, takerBps: 3.5 },
    private readonly rest = "https://fapi.asterdex.com",
    private readonly wsUrl = "wss://fstream.asterdex.com",
    private readonly symbolMap: Record<string, string> = {},
    private readonly levels = 20,
  ) {
    this.fees = fees;
  }

  private native(s: string): string {
    return this.symbolMap[s] ?? `${s}USDT`;
  }

  async start(symbols: string[]): Promise<void> {
    const r = await fetch(this.rest + "/fapi/v3/exchangeInfo");
    if (!r.ok) throw new Error(`aster exchangeInfo HTTP ${r.status}`);
    const listed = new Set(((await r.json()) as { symbols?: { symbol: string; status?: string }[] }).symbols?.filter((x) => !x.status || x.status === "TRADING").map((x) => x.symbol) ?? []);
    this.active = symbols.filter((s) => listed.has(this.native(s)));
    await this.pollFunding().catch((e) => this.log("aster funding failed", { error: String(e) }));
    this.timer = setInterval(() => void this.pollFunding().catch(() => {}), 30_000);
    const streams = this.active.map((s) => `${this.native(s).toLowerCase()}@depth${this.levels}@100ms`).join("/");
    this.ws = new ReconnectingWs({
      url: `${this.wsUrl}/stream?streams=${streams}`,
      log: this.log,
      staleMs: 20_000,
      onOpen: () => {},
      onMessage: (raw) => {
        if (this.samples.length < 5) this.samples.push(raw.slice(0, 600));
        const p = parseAsterDepth(raw, Date.now());
        if (p) this.books.set(p.symbol, p.book);
      },
    });
    this.ws.start();
  }

  stop(): void {
    this.ws?.stop();
    if (this.timer) clearInterval(this.timer);
  }

  private async pollFunding(): Promise<void> {
    const [p, i] = await Promise.all([fetch(this.rest + "/fapi/v3/premiumIndex"), fetch(this.rest + "/fapi/v3/fundingInfo")]);
    if (!p.ok) throw new Error(`premiumIndex HTTP ${p.status}`);
    const intervals = i.ok ? parseAsterIntervals(await i.json()) : new Map<string, number>();
    for (const [k, v] of parseAsterFunding(await p.json(), intervals, Date.now())) this.fund.set(k, v);
  }

  book(symbol: string): Book | null {
    return this.books.get(this.native(symbol)) ?? null;
  }
  funding(symbol: string): Funding | null {
    return this.fund.get(this.native(symbol)) ?? null;
  }
  symbols(): string[] {
    return this.active;
  }
}
