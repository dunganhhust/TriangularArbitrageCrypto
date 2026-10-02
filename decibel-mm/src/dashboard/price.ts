/**
 * Live USD price of APT (the gas token), used only to show gas in dollars.
 *
 * Several public endpoints are tried in turn; the one that last worked is tried first and a failing
 * one is skipped for a while, so a blocked or rate-limited source does not slow the others down.
 * Nothing here touches keys, orders or the bot.
 */

export interface PriceSource {
  name: string;
  url: string;
  parse: (json: unknown) => number | null;
}

export interface PriceReading {
  usd: number;
  source: string;
  ts: number;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const o = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

export const DEFAULT_SOURCES: PriceSource[] = [
  {
    name: "Coinbase",
    url: "https://api.coinbase.com/v2/prices/APT-USD/spot",
    parse: (j) => Number(o(o(j).data).amount),
  },
  {
    name: "Kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=APTUSD",
    parse: (j) => {
      const r = o(o(j).result);
      const first = o(r[Object.keys(r)[0] ?? ""]);
      const c = first.c;
      return Array.isArray(c) ? Number(c[0]) : null;
    },
  },
  {
    name: "Binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=APTUSDT",
    parse: (j) => Number(o(j).price),
  },
  {
    name: "CoinGecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=aptos&vs_currencies=usd",
    parse: (j) => Number(o(o(j).aptos).usd),
  },
];

export interface PriceFeedOpts {
  sources?: PriceSource[];
  fetchFn?: FetchFn;
  /** Polling period. */
  everyMs?: number;
  timeoutMs?: number;
  /** A source that failed is skipped for this long. */
  cooldownMs?: number;
  now?: () => number;
}

/** Plausible range for APT in USD; anything else is a parse error or a bad quote. */
const sane = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0.01 && x < 10_000;

export class PriceFeed {
  private reading: PriceReading | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private preferred = 0;
  private readonly skipUntil = new Map<string, number>();
  private readonly sources: PriceSource[];
  private readonly fetchFn: FetchFn;
  private readonly everyMs: number;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: PriceFeedOpts = {}) {
    this.sources = opts.sources ?? DEFAULT_SOURCES;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
    this.everyMs = opts.everyMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Latest reading with its age, or null if no source has ever answered. */
  get(): { usd: number; source: string; ts: number; ageSec: number; stale: boolean } | null {
    const r = this.reading;
    if (!r) return null;
    const ageMs = this.now() - r.ts;
    return { ...r, ageSec: Math.round(ageMs / 1000), stale: ageMs > Math.max(15_000, this.everyMs * 5) };
  }

  /** One polling round: first working source wins. Safe to call concurrently. */
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const n = this.sources.length;
      for (let k = 0; k < n; k++) {
        const i = (this.preferred + k) % n;
        const src = this.sources[i]!;
        if ((this.skipUntil.get(src.name) ?? 0) > this.now()) continue;
        const usd = await this.ask(src);
        if (usd !== null) {
          this.reading = { usd, source: src.name, ts: this.now() };
          this.preferred = i;
          return;
        }
        this.skipUntil.set(src.name, this.now() + this.cooldownMs);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ask(src: PriceSource): Promise<number | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(src.url, { signal: ac.signal, headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const v = src.parse(await res.json());
      return sane(v) ? v : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
