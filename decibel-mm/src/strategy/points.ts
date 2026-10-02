import type { Fill } from "../types.js";

export interface PointsConfig {
  /**
   * Maximum average net cost (bps of traded notional, after fees and adverse selection) the
   * operator is willing to pay for points. 0 = break-even farming. Negative = demand profit.
   */
  costBudgetBps: number;
  /** Bounds on the spread multiplier the controller may apply. */
  minSpreadMult: number;
  maxSpreadMult: number;
  /** Daily notional (USD, both sides) that is comfortably above the streak threshold. */
  dailyVolumeTargetUsd: number;
  /** Daily notional the operator believes is required to keep a streak alive. */
  streakMinVolumeUsd: number;
  /** Fill markout horizon. */
  markoutMs: number;
  /** EWMA half-life in traded USD. Larger = slower, steadier. */
  ewmaHalfLifeUsd: number;
  /** Minimum traded USD in the EWMA before the controller reacts to cost. */
  minSampleUsd: number;
  /** Multiplicative step per control action. */
  step: number;
  /** Seconds between control actions. */
  controlIntervalMs: number;
}

interface Pending {
  fill: Fill;
  /** Fair/mid price at the time of the fill. */
  refMid: number;
}

export interface PointsStats {
  /** Half-month rebate cycle, e.g. "2026-10-A" (1st-15th) or "2026-10-B" (16th-end), UTC. */
  cycleKey: string;
  cycleMakerVolumeUsd: number;
  cycleTakerVolumeUsd: number;
  /** Maker share of this cycle's volume, or null before any volume. */
  cycleMakerRatio: number | null;
  dayKey: string;
  dayVolumeUsd: number;
  dayMakerVolumeUsd: number;
  dayTakerVolumeUsd: number;
  dayFeesUsd: number;
  /** EWMA realized PnL per notional in bps (spread capture + markout - fees). Positive = earning. */
  ewmaPnlBps: number;
  ewmaSampleUsd: number;
  spreadMult: number;
  scheduleFrac: number;
  volumeFrac: number;
  streakSecured: boolean;
}

const DAY_MS = 86_400_000;
const utcDayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
export const cycleKeyOf = (ts: number): string => {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 7)}-${d.getUTCDate() <= 15 ? "A" : "B"}`;
};

/**
 * Adapts the quote aggressiveness to buy as much maker volume as the cost budget allows.
 *
 * The exact Amps formula is not documented publicly in a way this project can rely on, so the
 * controller optimises the only thing it can measure honestly: volume per unit of realized
 * cost. It tightens while measured cost is under budget (or the day's volume is behind
 * schedule) and widens when cost exceeds it.
 */
export class PointsController {
  private pending: Pending[] = [];
  private mult: number;
  private lastControl = 0;
  private day = "";
  private cycle = "";
  private cycleMaker = 0;
  private cycleTaker = 0;
  private dayVol = 0;
  private dayMaker = 0;
  private dayTaker = 0;
  private dayFees = 0;
  private ewmaNum = 0; // sum of pnlUsd, decayed
  private ewmaDen = 0; // sum of notional, decayed
  private now = 0;
  /** Gross markouts (bps, positive = good for us) of the most recent fills. */
  private recentMarkouts: number[] = [];

  constructor(
    private readonly cfg: PointsConfig,
    initialMult = 1,
  ) {
    this.mult = clamp(initialMult, cfg.minSpreadMult, cfg.maxSpreadMult);
  }

  /** Restore the day's counters after a restart. */
  restore(s: { dayKey: string; dayVolumeUsd: number; spreadMult?: number }): void {
    this.day = s.dayKey;
    this.dayVol = s.dayVolumeUsd;
    if (s.spreadMult) this.mult = clamp(s.spreadMult, this.cfg.minSpreadMult, this.cfg.maxSpreadMult);
  }

  /** Restore this half-month cycle's volumes after a restart (ignored if the cycle has changed). */
  restoreCycle(s: { cycleKey: string; makerUsd: number; takerUsd: number }, now: number): void {
    if (s.cycleKey !== cycleKeyOf(now)) return;
    this.cycle = s.cycleKey;
    this.cycleMaker = s.makerUsd;
    this.cycleTaker = s.takerUsd;
  }

  onFill(fill: Fill, refMid: number): void {
    this.rollDay(fill.ts);
    const n = fill.price * fill.size;
    this.dayVol += n;
    if (fill.isMaker) {
      this.dayMaker += n;
      this.cycleMaker += n;
    } else {
      this.dayTaker += n;
      this.cycleTaker += n;
    }
    this.dayFees += fill.feeUsd;
    this.pending.push({ fill, refMid });
  }

  /** Resolve fills whose markout horizon elapsed; call with the current mid for each market. */
  tick(now: number, midOf: (market: string) => number | undefined): void {
    this.now = now;
    this.rollDay(now);
    const keep: Pending[] = [];
    for (const p of this.pending) {
      if (now - p.fill.ts < this.cfg.markoutMs) {
        keep.push(p);
        continue;
      }
      const mid = midOf(p.fill.market);
      if (mid === undefined) {
        if (now - p.fill.ts < this.cfg.markoutMs * 10) keep.push(p);
        continue;
      }
      this.absorb(p.fill, mid);
    }
    this.pending = keep;
  }

  private absorb(fill: Fill, laterMid: number): void {
    const dir = fill.side === "buy" ? 1 : -1;
    const n = fill.price * fill.size;
    // PnL versus the later mid: buy below it / sell above it is positive.
    const pnlUsd = dir * (laterMid - fill.price) * fill.size - fill.feeUsd;
    const lambda = Math.pow(0.5, n / this.cfg.ewmaHalfLifeUsd);
    this.ewmaNum = this.ewmaNum * lambda + pnlUsd;
    this.ewmaDen = this.ewmaDen * lambda + n;
    this.recentMarkouts.push((dir * (laterMid - fill.price)) / fill.price * 1e4);
    if (this.recentMarkouts.length > 20) this.recentMarkouts.shift();
  }

  /** Average gross markout of the last `n` resolved fills, or null with fewer than `n`. */
  toxicity(n: number): number | null {
    if (this.recentMarkouts.length < n) return null;
    const w = this.recentMarkouts.slice(-n);
    return w.reduce((a, b) => a + b, 0) / n;
  }

  /** Forget recent markouts (after the fuse has acted on them). */
  resetToxicity(): void {
    this.recentMarkouts = [];
  }

  private rollDay(ts: number): void {
    const ck = cycleKeyOf(ts);
    if (ck !== this.cycle) {
      this.cycle = ck;
      this.cycleMaker = this.cycleTaker = 0;
    }
    const key = utcDayKey(ts);
    if (key !== this.day) {
      this.day = key;
      this.dayVol = this.dayMaker = this.dayTaker = this.dayFees = 0;
    }
  }

  /** Current multiplier for the half spread. Safe to call every step. */
  spreadMult(now: number): number {
    this.now = now;
    this.rollDay(now);
    if (now - this.lastControl < this.cfg.controlIntervalMs) return this.mult;
    this.lastControl = now;

    const { cfg } = this;
    const frac = this.scheduleFrac(now);
    const volFrac = cfg.dailyVolumeTargetUsd > 0 ? this.dayVol / cfg.dailyVolumeTargetUsd : 1;
    const behind = volFrac < frac - 0.1;
    const secured = this.dayVol >= cfg.streakMinVolumeUsd;
    const pnlBps = this.ewmaDen > 0 ? (this.ewmaNum / this.ewmaDen) * 1e4 : 0;
    const enough = this.ewmaDen >= cfg.minSampleUsd;
    const floorPnl = -cfg.costBudgetBps;

    let next = this.mult;
    if (enough && pnlBps < floorPnl) {
      // Costing more than the budget: back off.
      next = this.mult * cfg.step;
    } else if (behind && (!enough || pnlBps >= floorPnl)) {
      // Under budget but behind schedule: pay up for volume.
      next = this.mult / cfg.step;
    } else if (enough && pnlBps > floorPnl + Math.abs(floorPnl) * 0.5 + 0.25) {
      // Comfortably under budget: tighten to collect more volume.
      next = this.mult / cfg.step;
    } else if (secured && volFrac >= 1 && this.mult < 1) {
      // Target hit: drift back toward neutral instead of chasing more volume.
      next = this.mult * Math.sqrt(cfg.step);
    }
    this.mult = clamp(next, cfg.minSpreadMult, cfg.maxSpreadMult);
    return this.mult;
  }

  private scheduleFrac(now: number): number {
    return (now % DAY_MS) / DAY_MS;
  }

  stats(now: number): PointsStats {
    this.rollDay(now);
    const cv = this.cycleMaker + this.cycleTaker;
    return {
      cycleKey: this.cycle,
      cycleMakerVolumeUsd: this.cycleMaker,
      cycleTakerVolumeUsd: this.cycleTaker,
      cycleMakerRatio: cv > 0 ? this.cycleMaker / cv : null,
      dayKey: this.day,
      dayVolumeUsd: this.dayVol,
      dayMakerVolumeUsd: this.dayMaker,
      dayTakerVolumeUsd: this.dayTaker,
      dayFeesUsd: this.dayFees,
      ewmaPnlBps: this.ewmaDen > 0 ? (this.ewmaNum / this.ewmaDen) * 1e4 : 0,
      ewmaSampleUsd: this.ewmaDen,
      spreadMult: this.mult,
      scheduleFrac: this.scheduleFrac(now),
      volumeFrac: this.cfg.dailyVolumeTargetUsd > 0 ? this.dayVol / this.cfg.dailyVolumeTargetUsd : 1,
      streakSecured: this.dayVol >= this.cfg.streakMinVolumeUsd,
    };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
