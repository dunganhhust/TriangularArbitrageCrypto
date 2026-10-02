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
  private dayVol = 0;
  private dayMaker = 0;
  private dayTaker = 0;
  private dayFees = 0;
  private ewmaNum = 0; // sum of pnlUsd, decayed
  private ewmaDen = 0; // sum of notional, decayed
  private now = 0;

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

  onFill(fill: Fill, refMid: number): void {
    this.rollDay(fill.ts);
    const n = fill.price * fill.size;
    this.dayVol += n;
    if (fill.isMaker) this.dayMaker += n;
    else this.dayTaker += n;
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
  }

  private rollDay(ts: number): void {
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
    return {
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
