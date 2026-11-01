import { normalize } from "../book.js";
import type { Book, Funding, Log, Venue, VenueFees } from "../types.js";

type Units = "human" | "chain";

/** Decide whether depth numbers are chain units (value * 10^decimals) or human units, from the oracle price. */
export function unitsFromOracle(samplePx: number[], oracle: number, pxDecimals: number): Units {
  const xs = samplePx.filter((x) => x > 0);
  if (!xs.length || !(oracle > 0)) return "human";
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean / oracle / 10 ** pxDecimals > 0.2 && mean / oracle / 10 ** pxDecimals < 5 ? "chain" : "human";
}

interface Row {
  price: number;
  size: number;
}

/** Decibel via its SDK (needs APTOS_NODE_API_KEY). Common symbol "ETH" maps to market "ETH/USD". */
export class Decibel implements Venue {
  readonly name = "decibel";
  readonly fees: VenueFees;
  samples: string[] = [];
  private books = new Map<string, Book>();
  private fund = new Map<string, Funding>();
  private unsubs: (() => void)[] = [];
  private active: string[] = [];

  constructor(
    private readonly log: Log,
    private readonly apiKey: string,
    fees: VenueFees = { makerBps: 1.5, takerBps: 4.5 },
    private readonly quote = "USD",
    private readonly fundingHoursPerRate = 1,
  ) {
    this.fees = fees;
  }

  async start(symbols: string[]): Promise<void> {
    const sdk = await import("@decibeltrade/sdk");
    const read = new sdk.DecibelReadDex(sdk.MAINNET_CONFIG, { nodeApiKey: this.apiKey, onWsError: (e: unknown) => this.log("decibel ws error", { error: String((e as { message?: string }).message ?? e) }) });
    const all = await read.markets.getAll();
    for (const s of symbols) {
      const name = `${s}/${this.quote}`;
      const m = all.find((x: { market_name: string }) => x.market_name === name);
      if (!m || m.mode !== "Open") continue;
      const price = await read.marketPrices.getByName({ marketName: name });
      const first = Array.isArray(price) ? price[0] : price;
      const oracle = Number(first?.oracle_px ?? first?.mid_px);
      let units: Units | null = null;
      const scale = (): number => (units === "chain" ? 10 ** m.px_decimals : 1);
      const sscale = (): number => (units === "chain" ? 10 ** m.sz_decimals : 1);
      this.unsubs.push(
        read.marketDepth.subscribeByName(name, 1, (d: { bids: Row[]; asks: Row[]; unix_ms: number }) => {
          if (this.samples.length < 5) this.samples.push(JSON.stringify({ bids: d.bids.slice(0, 2), asks: d.asks.slice(0, 2) }));
          units ??= unitsFromOracle([...d.bids, ...d.asks].map((l) => l.price), oracle, m.px_decimals);
          const conv = (l: Row): Row => ({ price: l.price / scale(), size: l.size / sscale() });
          this.books.set(s, normalize(d.bids.map(conv), d.asks.map(conv), Date.now()));
        }),
      );
      const onPrice = (p: { funding_rate_bps?: number; is_funding_positive?: boolean }): void => {
        if (typeof p.funding_rate_bps !== "number") return;
        const bps = p.is_funding_positive === false ? -p.funding_rate_bps : p.funding_rate_bps;
        this.fund.set(s, { ratePerHour: bps / 1e4 / this.fundingHoursPerRate, ts: Date.now() });
      };
      if (first) onPrice(first as never);
      this.unsubs.push(
        read.marketPrices.subscribeByName(name, (p: unknown) => onPrice(((p as { price?: unknown }).price ?? p) as never)),
      );
      this.active.push(s);
    }
  }

  stop(): void {
    this.unsubs.forEach((u) => {
      try {
        u();
      } catch {
        /* ignore */
      }
    });
  }

  book(symbol: string): Book | null {
    return this.books.get(symbol) ?? null;
  }
  funding(symbol: string): Funding | null {
    return this.fund.get(symbol) ?? null;
  }
  symbols(): string[] {
    return this.active;
  }
}
