import type { Config } from "../config.js";
import type { AccountInfo, Book, BookLevel, Fill, Ladder, MarketSpec, PriceInfo } from "../types.js";
import type { Exchange, GasStats, ReduceRequest } from "./exchange.js";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sim {
  spec: MarketSpec;
  mid: number;
  ladder: Ladder;
  position: number;
  cash: number;
}

/**
 * Crude venue simulator for dry runs and tests: a random-walk fair price, a synthetic
 * touch around it, Poisson taker flow that walks the book, and "price moved through me"
 * fills (adverse selection). It exists to exercise the engine, not to forecast PnL.
 */
export class PaperExchange implements Exchange {
  private sims = new Map<string, Sim>();
  private fills: Fill[] = [];
  private rand: () => number;
  private last = 0;
  private fillSeq = 0;
  private startEquity: number;
  private t0 = 0;
  private shocked = false;
  public txCount = 0;

  constructor(
    private readonly cfg: Config["paper"],
    private readonly marketNames: string[],
  ) {
    this.rand = rng(cfg.seed);
    this.startEquity = cfg.equityUsd;
  }

  async init(names: string[]): Promise<MarketSpec[]> {
    const out: MarketSpec[] = [];
    for (const name of names) {
      const mid = this.cfg.startMid;
      const tick = mid > 1000 ? 0.1 : mid > 10 ? 0.01 : 0.0001;
      const spec: MarketSpec = {
        name,
        addr: `0xpaper_${name}`,
        pxDecimals: mid > 1000 ? 1 : mid > 10 ? 2 : 4,
        szDecimals: 4,
        tickSize: tick,
        lotSize: 0.0001,
        minSize: 0.0001,
      };
      this.sims.set(name, { spec, mid, ladder: { bids: [], asks: [] }, position: 0, cash: 0 });
      out.push(spec);
    }
    return out;
  }
  async close(): Promise<void> {}

  private sim(m: string): Sim {
    const s = this.sims.get(m);
    if (!s) throw new Error(`unknown market ${m}`);
    return s;
  }

  private gauss(): number {
    const u = Math.max(this.rand(), 1e-12);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private marketQuotes(s: Sim): { bid: number; ask: number } {
    const h = this.cfg.marketHalfSpreadBps / 1e4;
    const t = s.spec.tickSize;
    return { bid: Math.floor((s.mid * (1 - h)) / t) * t, ask: Math.ceil((s.mid * (1 + h)) / t) * t };
  }

  /** Advance the simulation to `now` (ms). Call once per engine tick. */
  advance(now: number): void {
    if (this.last === 0) {
      this.last = now;
      this.t0 = now;
      return;
    }
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    if (dt === 0) return;
    const elapsed = (now - this.t0) / 1000;
    const bursting = this.cfg.burstAtSec !== undefined && elapsed >= this.cfg.burstAtSec && elapsed < this.cfg.burstAtSec + this.cfg.burstSec;
    const sigma = (this.cfg.annualVolPct / 100 / Math.sqrt(365 * 86400)) * (bursting ? this.cfg.burstMult : 1);
    const shock = !this.shocked && this.cfg.shockAtSec !== undefined && (now - this.t0) / 1000 >= this.cfg.shockAtSec;
    if (shock) this.shocked = true;
    for (const s of this.sims.values()) {
      this.flow(s, dt, now);
      s.mid *= Math.exp(sigma * Math.sqrt(dt) * this.gauss());
      if (shock) s.mid *= 1 + this.cfg.shockPct / 100; // gap move through resting quotes
      this.crossThrough(s, now);
    }
  }

  private flow(s: Sim, dt: number, now: number): void {
    const n = poisson(this.cfg.flowPerSec * dt, this.rand);
    for (let k = 0; k < n; k++) {
      const sell = this.rand() < 0.5; // sells hit bids
      let remaining = -Math.log(Math.max(this.rand(), 1e-12)) * 3_000; // USD
      const reach = (-Math.log(Math.max(this.rand(), 1e-12)) * 1.5) / 1e4;
      const q = this.marketQuotes(s);
      if (sell) {
        const worst = q.bid * (1 - reach);
        for (const b of s.ladder.bids) {
          if (b.price < worst || remaining <= 0) break;
          const take = Math.min(b.size, remaining / b.price);
          if (take > 0) remaining -= this.fill(s, "buy", b.price, take, now);
        }
      } else {
        const worst = q.ask * (1 + reach);
        for (const a of s.ladder.asks) {
          if (a.price > worst || remaining <= 0) break;
          const take = Math.min(a.size, remaining / a.price);
          if (take > 0) remaining -= this.fill(s, "sell", a.price, take, now);
        }
      }
    }
  }

  /** Our quote is on the wrong side of the new fair price: it gets picked off in full. */
  private crossThrough(s: Sim, now: number): void {
    for (const b of [...s.ladder.bids]) if (b.price >= s.mid) this.fill(s, "buy", b.price, b.size, now);
    for (const a of [...s.ladder.asks]) if (a.price <= s.mid) this.fill(s, "sell", a.price, a.size, now);
  }

  /** Returns filled notional. Mutates the resting quote. */
  private fill(s: Sim, side: "buy" | "sell", price: number, size: number, ts: number): number {
    const list = side === "buy" ? s.ladder.bids : s.ladder.asks;
    const q = list.find((x) => x.price === price);
    if (!q) return 0;
    const sz = Math.min(size, q.size);
    q.size = Number((q.size - sz).toFixed(8));
    if (q.size <= 0) list.splice(list.indexOf(q), 1);
    s.position += side === "buy" ? sz : -sz;
    s.cash += side === "buy" ? -price * sz : price * sz;
    const fee = (price * sz * this.cfg.makerFeeBps) / 1e4;
    s.cash -= fee;
    this.fills.push({ id: `p${++this.fillSeq}`, market: s.spec.name, side, price, size: sz, feeUsd: fee, isMaker: true, ts });
    return price * sz;
  }

  getBook(market: string): Book | null {
    const s = this.sim(market);
    const q = this.marketQuotes(s);
    const t = s.spec.tickSize;
    const mk = (base: number, dir: 1 | -1): BookLevel[] =>
      [0, 1, 2].map((i) => ({ price: Number((base + dir * i * t * 5).toFixed(s.spec.pxDecimals)), size: 0.5 * (i + 1) }));
    const bids = merge(mk(q.bid, -1), s.ladder.bids, "desc");
    const asks = merge(mk(q.ask, 1), s.ladder.asks, "asc");
    return { bids, asks, ts: this.last };
  }
  getPrice(market: string): PriceInfo | null {
    const s = this.sim(market);
    return { mark: s.mid, mid: s.mid, oracle: s.mid, fundingBps: 0, ts: this.last };
  }
  getFees(): { maker: number; taker: number } {
    return { maker: this.cfg.makerFeeBps / 1e4, taker: this.cfg.takerFeeBps / 1e4 };
  }
  /** Gas is modelled only when `paper.gasAptPerTx` is set; otherwise the venue reports none (as before). */
  getGas(): GasStats | null {
    if (!this.cfg.gasAptPerTx) return null;
    return { txCount: this.txCount, gasApt: this.txCount * this.cfg.gasAptPerTx, balanceApt: null };
  }
  getPosition(market: string): number {
    return this.sim(market).position;
  }
  getAccount(): AccountInfo {
    let eq = this.startEquity;
    for (const s of this.sims.values()) eq += s.cash + s.position * s.mid;
    return { equityUsd: eq, ts: this.last };
  }
  drainFills(): Fill[] {
    const f = this.fills;
    this.fills = [];
    return f;
  }
  async replaceLadder(market: string, ladder: Ladder): Promise<boolean> {
    this.txCount++;
    this.sim(market).ladder = { bids: ladder.bids.map((x) => ({ ...x })), asks: ladder.asks.map((x) => ({ ...x })) };
    return true;
  }
  async cancelAll(market: string): Promise<boolean> {
    return this.replaceLadder(market, { bids: [], asks: [] });
  }
  async reduce(req: ReduceRequest): Promise<boolean> {
    this.txCount++;
    const s = this.sim(req.market);
    const q = this.marketQuotes(s);
    const px = req.side === "buy" ? q.ask : q.bid;
    const sz = Math.min(req.size, Math.abs(s.position));
    s.position += req.side === "buy" ? sz : -sz;
    s.cash += req.side === "buy" ? -px * sz : px * sz;
    const fee = (px * sz * this.cfg.takerFeeBps) / 1e4;
    s.cash -= fee;
    this.fills.push({ id: `p${++this.fillSeq}`, market: req.market, side: req.side, price: px, size: sz, feeUsd: fee, isMaker: false, ts: this.last });
    return true;
  }
  get names(): string[] {
    return this.marketNames;
  }
}

function merge(market: BookLevel[], ours: BookLevel[], order: "asc" | "desc"): BookLevel[] {
  const m = new Map<number, number>();
  for (const l of [...market, ...ours]) m.set(l.price, (m.get(l.price) ?? 0) + l.size);
  return [...m.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => (order === "asc" ? a.price - b.price : b.price - a.price));
}

function poisson(lambda: number, rand: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L && k < 100);
  return k - 1;
}
