import { normalize } from "../book.js";
import type { Book, Funding, Log, Venue, VenueFees } from "../types.js";
import { ReconnectingWs } from "../ws.js";

/** Wire shape: {channel:"l2Book", data:{coin, time, levels:[[{px,sz,n}...bids],[...asks]]}}. */
export function parseHlBook(raw: string): { coin: string; book: Book } | null {
  let m: { channel?: string; data?: { coin?: string; time?: number; levels?: { px: string; sz: string }[][] } };
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (m.channel !== "l2Book" || !m.data?.coin || !Array.isArray(m.data.levels) || m.data.levels.length < 2) return null;
  const conv = (ls: { px: string; sz: string }[]) => ls.map((l) => ({ price: Number(l.px), size: Number(l.sz) }));
  return { coin: m.data.coin, book: normalize(conv(m.data.levels[0]!), conv(m.data.levels[1]!), m.data.time ?? Date.now()) };
}

/** metaAndAssetCtxs answer: [{universe:[{name}]}, [{funding, ...}]]. Hyperliquid funding is a fraction per hour. */
export function parseHlFunding(body: unknown, ts: number): Map<string, Funding> {
  const out = new Map<string, Funding>();
  if (!Array.isArray(body) || body.length < 2) return out;
  const uni = (body[0] as { universe?: { name: string }[] }).universe ?? [];
  const ctx = body[1] as { funding?: string }[];
  uni.forEach((u, i) => {
    const f = Number(ctx[i]?.funding);
    if (Number.isFinite(f)) out.set(u.name, { ratePerHour: f, ts });
  });
  return out;
}

export class Hyperliquid implements Venue {
  readonly name: string;
  readonly fees: VenueFees;
  samples: string[] = [];
  private books = new Map<string, Book>();
  private fund = new Map<string, Funding>();
  private ws: ReconnectingWs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private coins: string[] = [];

  constructor(
    private readonly log: Log,
    fees: VenueFees = { makerBps: 1.5, takerBps: 4.5 },
    private readonly url = "https://api.hyperliquid.xyz",
    private readonly symbolMap: Record<string, string> = {},
    /** HIP-3 builder deployment (e.g. "xyz" for trade.xyz); empty for Hyperliquid's own perps. */
    private readonly dex = "",
    name = "hyperliquid",
  ) {
    this.fees = fees;
    this.name = name;
  }

  async start(symbols: string[]): Promise<void> {
    this.coins = symbols.map((s) => this.symbolMap[s] ?? s);
    await this.pollFunding();
    this.coins = this.coins.filter((c) => this.fund.has(c));
    this.timer = setInterval(() => void this.pollFunding().catch((e) => this.log("hl funding failed", { error: String(e) })), 30_000);
    this.ws = new ReconnectingWs({
      url: this.url.replace(/^http/, "ws") + "/ws",
      log: this.log,
      staleMs: 20_000,
      onOpen: (send) => this.coins.forEach((coin) => send({ method: "subscribe", subscription: { type: "l2Book", coin } })),
      onMessage: (raw) => {
        if (this.samples.length < 5) this.samples.push(raw.slice(0, 600));
        const p = parseHlBook(raw);
        if (p) this.books.set(p.coin, { ...p.book, ts: Date.now() }); // receipt time: immune to clock skew
      },
    });
    this.ws.start();
  }

  stop(): void {
    this.ws?.stop();
    if (this.timer) clearInterval(this.timer);
  }

  private async pollFunding(): Promise<void> {
    const r = await fetch(this.url + "/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.dex ? { type: "metaAndAssetCtxs", dex: this.dex } : { type: "metaAndAssetCtxs" }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const [k, v] of parseHlFunding(await r.json(), Date.now())) this.fund.set(k, v);
  }

  private native(symbol: string): string {
    return this.symbolMap[symbol] ?? symbol;
  }
  book(symbol: string): Book | null {
    return this.books.get(this.native(symbol)) ?? null;
  }
  funding(symbol: string): Funding | null {
    return this.fund.get(this.native(symbol)) ?? null;
  }
  symbols(): string[] {
    return this.coins;
  }
}
