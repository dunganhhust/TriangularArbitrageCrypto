import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config, MarketConfig } from "./config.js";
import type { Exchange } from "./exchange/exchange.js";
import { VolatilityFuse } from "./strategy/fuse.js";
import type { FuseStatus } from "./strategy/fuse.js";
import { PointsController } from "./strategy/points.js";
import { RampController } from "./strategy/ramp.js";
import {
  buildLadder,
  halfSpreadBps,
  isLadderThreatened,
  microprice,
  needsReplace,
  roundDownToStep,
  stripOwn,
  topDriftBps,
  topLevelUsd,
} from "./strategy/quoter.js";
import type { QuoteParams } from "./strategy/quoter.js";
import { assess } from "./strategy/risk.js";
import type { RiskConfig } from "./strategy/risk.js";
import type { Ladder, MarketSpec } from "./types.js";
import type { DaySummary } from "./strategy/points.js";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

let runLogFile: string | null = null;
let runLogMax = 0;
let runLogBytes = 0;
/** The run's start line is carried over into a fresh file after a rotation, so the dashboard still sees a run. */
let runLogStart: string | null = null;

/**
 * Also append every log line to this file (the dashboard reads it). null/empty = stdout only. With `maxBytes` the
 * file is moved to `<path>.1` (replacing the previous one) once it grows past that size.
 */
export function setRunLogFile(path: string | null, maxBytes = 0): void {
  runLogFile = path || null;
  runLogMax = maxBytes;
  runLogStart = null;
  runLogBytes = 0;
  if (!runLogFile) return;
  mkdirSync(dirname(runLogFile), { recursive: true });
  try {
    runLogBytes = statSync(runLogFile).size;
  } catch {
    /* new file */
  }
}

function appendRunLog(line: string): void {
  if (!runLogFile) return;
  try {
    if (runLogMax > 0 && runLogBytes + line.length > runLogMax) {
      renameSync(runLogFile, `${runLogFile}.1`);
      runLogBytes = 0;
      if (runLogStart) {
        appendFileSync(runLogFile, runLogStart + "\n");
        runLogBytes = runLogStart.length + 1;
      }
    }
    appendFileSync(runLogFile, line + "\n");
    runLogBytes += line.length + 1;
  } catch {
    // Logging must never be able to stop the bot.
  }
}

export const jsonLogger: Logger = (level, msg, extra) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  console.log(line);
  if (msg === "market maker started") runLogStart = line;
  appendRunLog(line);
};

interface MarketState {
  spec: MarketSpec;
  cfg: MarketConfig;
  /** The ladder we believe is resting: what was sent, less what has been filled since. */
  live: Ladder | null;
  /** The ladder exactly as last sent. Staleness is judged against this, so that a filled level does not look like drift. */
  placed: Ladder | null;
  lastReplaceAt: number;
  /** Jittered minimum gap before the next scheduled (non-urgent) replace. */
  nextInterval: number;
  dirty: boolean;
  samples: { ts: number; mid: number }[];
  failures: number;
  cooldownUntil: number;
  lastPause: string | null;
  fuse: VolatilityFuse;
  /** Most recent fuse verdict, for the live snapshot. */
  fuseStatus: FuseStatus;
  warnedTooSmall: boolean;
  /** Drift (bps) at which this market re-quotes at once, as last computed. */
  urgentBps: number;
  /** Position cap and first-level size (USD) in force at the last step. */
  sizeNow: { maxPos: number; level: number } | null;
}

export interface EngineOpts {
  /** Returns true when the operator wants everything stopped (e.g. KILL file exists). */
  killSwitch?: () => boolean;
  log?: Logger;
  /** Persist/restore the daily counters across restarts. */
  persist?: boolean;
  /** Source of randomness in [0,1) for refresh-interval jitter; injectable for tests. */
  rng?: () => number;
  /** Planned end of the run (epoch ms), shown in the live snapshot. The runner enforces it. */
  endsAt?: number | null;
  /** Pause between position polls while closing out; injectable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Live USD price of APT (the gas token), or null when unknown. Gas is only weighed in the controllers when known. */
  aptUsd?: () => number | null;
}

/** Why a ladder was re-sent; counted so the cost of each reason can be seen. */
export type ReplaceReason = "initial" | "threat" | "drift" | "fill" | "stale";
const REPLACE_REASONS: ReplaceReason[] = ["initial", "threat", "drift", "fill", "stale"];
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface FlattenResult {
  /** True when no market has a position left that the venue would let us close. */
  closed: boolean;
  /** Positions at or above the market minimum that are still open (base units, signed). */
  residual: Record<string, number>;
  /** Positions below the market minimum order size: too small to close with a normal order. */
  dust: Record<string, number>;
  /** Reduce-only orders sent. */
  orders: number;
}

/** Limit-price slack beyond the touch for each successive close-out attempt. */
const FLATTEN_SLIPPAGE_BPS = [10, 30, 60, 100, 200];

const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export class MarketMaker {
  readonly points: PointsController;
  readonly ramp: RampController;
  private readonly states = new Map<string, MarketState>();
  private readonly risk: RiskConfig;
  private readonly log: Logger;
  private readonly rng: () => number;
  private startEquity: number | null = null;
  private lastStatus = 0;
  private lastLive = 0;
  private liveWarned = false;
  private phase: "running" | "paused" | "flattening" | "done" = "running";
  private lastPointsPoll = 0;
  private lastSave = 0;
  private halted = false;
  private lastMid = new Map<string, number>();
  private fillCount = 0;
  private takerFills = 0;
  private tripCount = 0;
  private gasDay = "";
  private gasDayBase = 0;
  private gasPausedDay: string | null = null;
  /** Gas already spent on this UTC day by earlier processes (restored from the state file). */
  private gasCarryApt = 0;
  private lastGasApt: number | null = null;
  private startedAt: number | null = null;
  /** >= 1 while gas runs ahead of its daily budget: thresholds and refresh intervals are stretched by it. */
  private economy = 1;
  private readonly replaceCounts: Record<ReplaceReason, number> = { initial: 0, threat: 0, drift: 0, fill: 0, stale: 0 };
  private replaceTimes: number[] = [];
  private takerReduce = 0;
  private takerCross = 0;
  private crossTimes: number[] = [];
  private readonly lastReduceAt = new Map<string, number>();
  /** Set while positions or the account cannot be read: the bot is blind and keeps its quotes off. */
  private blindSince: number | null = null;
  /** Since when no market has had usable data (blind, or every book stale/empty); drives the watchdog. */
  private unhealthySince: number | null = null;
  /** Equity at the first look of the current UTC day: the baseline of the daily loss limit. */
  private dayStart: { key: string; equity: number } | null = null;
  private dailyPausedDay: string | null = null;
  /** >= 1: widening applied while the day's loss runs ahead of its schedule (see risk.maxPaceMult). */
  private lossPaceMult = 1;
  private lastPaceAt = 0;
  private lastPausedClose = 0;
  private dayFills = 0;
  private lastRunwayWarn = 0;
  /** Equity the equity-based sizes were last derived from. */
  private sizingEquity: number | null = null;
  /** Time of the current step (injected by the caller so simulations can run faster than real time). */
  private clock = 0;

  constructor(
    private readonly cfg: Config,
    private readonly ex: Exchange,
    specs: MarketSpec[],
    private readonly opts: EngineOpts = {},
  ) {
    this.log = opts.log ?? jsonLogger;
    this.rng = opts.rng ?? Math.random;
    this.points = new PointsController(cfg.points);
    this.points.onDayEnd = (d) => this.dayEnded(d);
    this.ramp = new RampController(cfg.ramp);
    this.risk = {
      staleBookMs: cfg.risk.staleBookMs,
      maxOracleDevBps: cfg.risk.maxOracleDevBps,
      maxSpreadBps: cfg.risk.maxSpreadBps,
      emergencyPositionUsd: 0, // set per market below
      reduceToUsd: 0,
      maxDrawdownUsd: cfg.risk.maxDrawdownUsd,
      maxConsecutiveFailures: cfg.risk.maxConsecutiveFailures,
      cooldownMs: cfg.risk.cooldownMs,
    };
    for (const mc of cfg.markets) {
      const spec = specs.find((s) => s.name === mc.name);
      if (!spec) throw new Error(`market ${mc.name} not found on venue`);
      this.states.set(mc.name, {
        spec,
        cfg: mc,
        live: null,
        placed: null,
        lastReplaceAt: 0,
        nextInterval: cfg.engine.minReplaceIntervalMs,
        dirty: true,
        samples: [],
        failures: 0,
        cooldownUntil: 0,
        lastPause: null,
        fuse: new VolatilityFuse(cfg.fuse),
        fuseStatus: { state: "ok" },
        warnedTooSmall: false,
        urgentBps: cfg.engine.urgentRepriceBps,
        sizeNow: null,
      });
    }
    if (opts.persist) this.restore();
  }

  get isHalted(): boolean {
    return this.halted;
  }

  /** One control iteration. `now` is injected so simulations can run faster than real time. */
  async step(now: number): Promise<void> {
    if (this.halted) return;
    this.clock = now;

    for (const f of this.ex.drainFills()) {
      const st = this.states.get(f.market);
      if (!st) continue;
      st.dirty = true; // resting sizes changed; re-send the full ladder
      if (f.isMaker) applyFillToLadder(st.live, f, st.spec);
      this.fillCount++;
      if (!f.isMaker) {
        this.takerFills++;
        // Our own reduce-only order, or a resting order the market reached before it landed (it then executes as taker)?
        const sinceReduce = now - (this.lastReduceAt.get(f.market) ?? -Infinity);
        const kind = sinceReduce >= 0 && sinceReduce < 10_000 ? "reduce" : "cross";
        if (kind === "reduce") this.takerReduce++;
        else {
          this.takerCross++;
          this.crossTimes.push(now);
        }
        this.log("warn", "taker fill: paid the taker fee and lowered the maker share", {
          market: f.market,
          side: f.side,
          px: f.price,
          sz: f.size,
          kind,
          ...(kind === "cross" ? { msSinceReplace: st.lastReplaceAt ? now - st.lastReplaceAt : null } : {}),
        });
      }
      this.points.onFill(f, this.lastMid.get(f.market) ?? f.price);
      this.dayFills++; // after onFill: a fill that opens a new UTC day must not be counted in the day it ends
      this.log("info", "fill", { market: f.market, side: f.side, px: f.price, sz: f.size, maker: f.isMaker, fee: round(f.feeUsd, 4) });
    }
    this.points.tick(now, (m) => this.lastMid.get(m));
    await this.checkToxicFlow(now);
    if (this.halted) return;

    const acct = this.ex.getAccount();
    if (acct && this.startEquity === null) this.startEquity = acct.equityUsd;
    if (acct) {
      this.rollEquityDay(now, acct.equityUsd);
      const floor = this.cfg.risk.minEquityUsd;
      if (floor > 0 && acct.equityUsd < floor) {
        this.log("error", "HALT", { reason: `equity ${round(acct.equityUsd, 2)} USD below the floor`, minEquityUsd: floor });
        await this.haltAll();
        return;
      }
    }
    if (await this.dailyLossGate(now, acct?.equityUsd ?? null)) {
      this.updateHealth(now);
      await this.housekeeping(now);
      return;
    }
    const blind = this.blindReason();
    if (blind) {
      await this.goBlind(now, blind);
      this.updateHealth(now);
      await this.housekeeping(now);
      return;
    }
    this.blindSince = null;

    if (this.startedAt === null) this.startedAt = now;
    const gas = this.ex.getGas?.() ?? null;
    if (gas) this.accountGas(now, gas.gasApt);
    if (gas && gas.balanceApt !== null && gas.balanceApt < this.cfg.risk.minGasBalanceApt) {
      this.log("error", "HALT", { reason: "signer APT balance below reserve", balanceApt: gas.balanceApt, minGasBalanceApt: this.cfg.risk.minGasBalanceApt });
      await this.haltAll();
      return;
    }
    if (gas && (await this.gasBudgetExceeded(now, gas.gasApt))) {
      await this.housekeeping(now); // keep the status line and live snapshot flowing while quotes are pulled
      return;
    }

    const ramp = this.ramp.update(now, acct?.equityUsd ?? null, { fills: this.fillCount, trips: this.tripCount });
    if (ramp.kind === "advanced") this.log("info", "ramp: stage up", { from: ramp.from, to: ramp.to, sizeMult: this.ramp.mult });
    if (ramp.kind === "demoted") this.log("warn", "ramp: stage down after loss", { from: ramp.from, to: ramp.to, lossPct: round(ramp.lossPct, 2), sizeMult: this.ramp.mult });
    if (ramp.kind === "exhausted") {
      this.log("error", "HALT", { reason: `loss ${round(ramp.lossPct, 2)}% at the smallest ramp stage` });
      await this.haltAll();
      return;
    }

    this.updateLossPace(now, acct?.equityUsd ?? null);
    const mult = this.points.spreadMult(now) * this.lossPaceMult;

    for (const st of this.states.values()) {
      await this.stepMarket(st, now, mult, acct?.equityUsd ?? null);
      if (this.halted) return;
    }

    this.updateHealth(now);
    await this.housekeeping(now);
  }

  /** Cancel quotes a previous process left resting (it crashed or was killed). Returns the markets that had some. */
  async cleanupLeftovers(): Promise<string[]> {
    let resting: string[];
    try {
      resting = (await this.ex.listResting?.()) ?? [];
    } catch (e) {
      this.log("warn", "could not list leftover quotes; cancelling on every market to be safe", { error: String(e) });
      resting = [...this.states.keys()];
    }
    const mine = resting.filter((n) => this.states.has(n));
    for (const name of mine) {
      try {
        await this.ex.cancelAll(name);
      } catch (e) {
        this.log("error", "cleanup: cancel failed", { market: name, error: String(e) });
      }
    }
    if (mine.length > 0) this.log("warn", "startup: cancelled quotes left behind by an earlier process", { markets: mine });
    return mine;
  }

  /** True once the data has been unusable for `engine.watchdogMs`: the runner then ends the process for a clean restart. */
  restartRequested(now: number): boolean {
    const w = this.cfg.engine.watchdogMs;
    return w > 0 && this.unhealthySince !== null && now - this.unhealthySince >= w;
  }

  /** Why the bot cannot trust its picture of the account right now, or null. */
  private blindReason(): string | null {
    const age = this.ex.dataAge?.();
    if (!age) return null;
    const max = this.cfg.risk.maxDataStaleMs;
    if (age.positionsMs !== null && age.positionsMs > max) return `positions not refreshed for ${Math.round(age.positionsMs / 1000)}s`;
    if (age.accountMs !== null && age.accountMs > max) return `account not refreshed for ${Math.round(age.accountMs / 1000)}s`;
    return null;
  }

  /** Positions and equity cannot be read: quoting on a stale picture risks piling up inventory unseen, so pull the quotes. */
  private async goBlind(now: number, why: string): Promise<void> {
    if (this.blindSince === null) {
      this.blindSince = now;
      this.log("error", "blind: pulling quotes until positions and account can be read again", { reason: why });
      await this.cancelAll();
      for (const st of this.states.values()) st.dirty = true;
    }
  }

  private updateHealth(now: number): void {
    const dead = this.blindSince !== null || [...this.states.values()].every((st) => st.lastPause === "stale book" || st.lastPause === "empty book");
    if (!dead) this.unhealthySince = null;
    else if (this.unhealthySince === null) this.unhealthySince = now;
  }

  private rollEquityDay(now: number, equity: number): void {
    const key = utcDay(now);
    if (this.dayStart?.key !== key) this.dayStart = { key, equity };
  }

  /**
   * Daily loss limit. Once the day's loss reaches `risk.maxDailyLossUsd` the bot closes every position and stays flat
   * until the next UTC day, then trades again by itself. Returns true while it is flat for the day.
   */
  private async dailyLossGate(now: number, equity: number | null): Promise<boolean> {
    const limit = this.cfg.risk.maxDailyLossUsd;
    if (limit <= 0) return false;
    const day = utcDay(now);
    if (this.dailyPausedDay === day) {
      if (now - this.lastPausedClose >= 30_000 && this.hasOpenPositions()) {
        this.lastPausedClose = now;
        await this.closeOut(1);
      }
      return true;
    }
    if (this.dailyPausedDay !== null) {
      this.dailyPausedDay = null;
      this.phase = "running";
      this.log("info", "new UTC day: quoting again after the daily loss pause");
      for (const st of this.states.values()) st.dirty = true;
    }
    if (equity === null || this.dayStart === null || this.dayStart.key !== day) return false;
    const lost = this.dayStart.equity - equity;
    if (lost < limit) return false;
    this.dailyPausedDay = day;
    this.phase = "paused";
    this.log("error", "daily loss limit reached: closing positions and staying flat until tomorrow (UTC)", { lostUsd: round(lost, 4), maxDailyLossUsd: limit, dayStartEquity: round(this.dayStart.equity, 2), equity: round(equity, 2) });
    await this.cancelAll();
    this.lastPausedClose = now;
    await this.closeOut();
    return true;
  }

  /**
   * Slow the quoting down while today's loss is ahead of a straight-line spend of the daily limit. The multiplier moves
   * by at most 10 % every 30 s, so it never makes the quotes jump (every jump would cost a transaction).
   */
  private updateLossPace(now: number, equity: number | null): void {
    if (now - this.lastPaceAt < 30_000) return;
    this.lastPaceAt = now;
    const limit = this.cfg.risk.maxDailyLossUsd;
    let target = 1;
    if (limit > 0 && equity !== null && this.dayStart !== null && this.dayStart.key === utcDay(now)) {
      const lost = Math.max(0, this.dayStart.equity - equity);
      const allowed = limit * Math.max((now % DAY_MS) / DAY_MS, 0.1);
      target = Math.min(this.cfg.risk.maxPaceMult, Math.max(1, lost / allowed));
    }
    this.lossPaceMult = target > this.lossPaceMult ? Math.min(target, this.lossPaceMult * 1.1) : Math.max(target, this.lossPaceMult / 1.1);
  }

  private hasOpenPositions(): boolean {
    for (const [name, st] of this.states) {
      if (roundDownToStep(Math.abs(this.ex.getPosition(name)), st.spec.lotSize) >= st.spec.minSize) return true;
    }
    return false;
  }

  /** Called by the points controller when a UTC day ends, with that day's totals. */
  private dayEnded(d: DaySummary): void {
    const eq = this.ex.getAccount()?.equityUsd ?? null;
    const row = {
      day: d.day,
      volumeUsd: round(d.volumeUsd, 2),
      makerVolumeUsd: round(d.makerVolumeUsd, 2),
      takerVolumeUsd: round(d.takerVolumeUsd, 2),
      fills: this.dayFills,
      feesUsd: round(d.feesUsd, 4),
      gasUsd: round(d.gasUsd, 4),
      equityStart: this.dayStart && this.dayStart.key === d.day ? round(this.dayStart.equity, 4) : null,
      equityEnd: eq === null ? null : round(eq, 4),
      replaces: Object.values(this.replaceCounts).reduce((a, b) => a + b, 0),
      takerCross: this.takerCross,
      takerReduce: this.takerReduce,
      fuseTrips: this.tripCount,
      spreadMult: round(this.points.stats(this.clock).spreadMult, 3),
    };
    this.dayFills = 0;
    this.log("info", "daily summary", row);
    const file = this.cfg.engine.dailyLogFile;
    if (!file || !this.opts.persist) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, Object.keys(row).join(",") + "\n");
      appendFileSync(file, Object.values(row).map((v) => (v === null ? "" : String(v))).join(",") + "\n");
    } catch (e) {
      this.log("warn", "daily summary write failed", { error: String(e) });
    }
  }

  /** True when a taker reduce should wait: it would cost the rebate and the position is not yet extreme. */
  private holdTakerReduce(posUsd: number, maxPos: number): boolean {
    const r = this.cfg.rebate;
    if (!r.enabled) return false;
    const ratio = this.points.stats(this.clock).cycleMakerRatio;
    if (ratio === null || ratio > r.minMakerRatio + r.ratioBuffer) return false;
    return Math.abs(posUsd) <= maxPos * this.cfg.risk.emergencyPositionMult * 2;
  }

  /** Gas spent since the last step goes into the cost average that the spread controller reads. */
  private accountGas(now: number, gasApt: number): void {
    if (this.lastGasApt !== null && gasApt > this.lastGasApt) {
      const apt = this.aptUsdNow();
      if (apt !== null) this.points.onGasCost((gasApt - this.lastGasApt) * apt, now);
    }
    this.lastGasApt = gasApt;
  }

  /** USD per APT from the live feed, else the configured fallback, else null (gas is then not priced). */
  private aptUsdNow(): number | null {
    const v = this.opts.aptUsd?.() ?? this.cfg.gas.aptUsdFallback;
    return v !== null && v > 0 ? v : null;
  }

  /** Dollar cost of one transaction: observed average once there are enough of them, the assumed figure before. */
  private gasUsdPerTx(): number | null {
    const apt = this.aptUsdNow();
    if (apt === null) return null;
    const g = this.ex.getGas?.() ?? null;
    const perTx = g && g.txCount >= 5 && g.gasApt > 0 ? g.gasApt / g.txCount : this.cfg.gas.assumedAptPerTx;
    return perTx * apt;
  }

  /**
   * Drift (bps) at which a market re-quotes at once. A stale quote costs about (drift - half spread) x its
   * size x the chance it is hit; fixing it costs one transaction. They are equal at
   * half spread + gas(bps of the top level) / staleFillProb, so cheap gas or big levels re-quote sooner and tiny
   * levels wait. Without a gas price (or with `staleFillProb` 0) it is the fixed `urgentRepriceBps`. `economy`
   * stretches the result while gas is running over its daily budget.
   */
  private urgentThresholdBps(qp: QuoteParams, target: Ladder): number {
    const e = this.cfg.engine;
    const fixed = e.urgentRepriceBps * this.economy;
    const gasUsd = this.gasUsdPerTx();
    const top = topLevelUsd(target);
    if (e.staleFillProb <= 0 || gasUsd === null || !(top > 0)) return fixed;
    const econ = halfSpreadBps(qp) + ((gasUsd / top) * 1e4) / e.staleFillProb;
    return Math.min(e.urgentMaxBps, Math.max(e.urgentMinBps, econ)) * this.economy;
  }

  /** Extra ticks kept away from the opposite touch: the configured guard plus one per few recent taker crossings. */
  private guardTicks(now: number): number {
    const c = this.cfg.competition;
    this.crossTimes = this.crossTimes.filter((t) => now - t < HOUR_MS);
    const extra = c.crossesPerTick > 0 ? Math.min(c.maxGuardTicks, Math.floor(this.crossTimes.length / c.crossesPerTick)) : 0;
    return c.touchGuardTicks + extra;
  }

  /** Gas spent today across this and earlier processes, in APT. */
  private gasSpentToday(gasApt: number): number {
    return this.gasCarryApt + (gasApt - this.gasDayBase);
  }

  /** Pull quotes for the rest of the UTC day once the gas budget is spent; before that, slow down if spending runs ahead. */
  private async gasBudgetExceeded(now: number, gasApt: number): Promise<boolean> {
    const day = utcDay(now);
    if (day !== this.gasDay) {
      if (this.gasDay !== "") this.gasCarryApt = 0;
      this.gasDay = day;
      this.gasDayBase = gasApt;
      this.gasPausedDay = null;
    }
    if (this.gasPausedDay === day) return true;
    const spent = this.gasSpentToday(gasApt);
    const budget = this.cfg.risk.maxGasAptPerDay;
    this.economy = Math.min(this.cfg.engine.economyMaxMult, Math.max(1, spent / (budget * Math.max((now % DAY_MS) / DAY_MS, 0.05))));
    if (spent < budget) return false;
    this.gasPausedDay = day;
    this.log("error", "gas budget for the day spent; pulling quotes until tomorrow (UTC)", { spentApt: round(spent, 6), maxGasAptPerDay: budget });
    await this.cancelAll();
    return true;
  }

  /** Recent fills keep being picked off: treat it as a toxic regime and trip every fuse. */
  private async checkToxicFlow(now: number): Promise<void> {
    const f = this.cfg.fuse;
    if (!f.enabled) return;
    const avg = this.points.toxicity(f.toxicFills);
    if (avg === null || avg > -f.toxicMarkoutBps) return;
    this.points.resetToxicity();
    for (const st of this.states.values()) {
      const s = st.fuse.trip(now, `toxic flow: last ${f.toxicFills} fills averaged ${round(avg, 1)} bps`);
      st.fuseStatus = s;
      if (s.state === "halt") {
        this.log("error", "HALT", { market: st.spec.name, reason: s.reason });
        await this.haltAll();
        return;
      }
      if (s.state === "tripped" && s.justTripped) {
        this.tripCount++;
        this.log("warn", "FUSE tripped: pulling quotes", { market: st.spec.name, reason: s.reason, pauseSec: Math.round((s.until - now) / 1000) });
      }
    }
  }

  private async stepMarket(st: MarketState, now: number, mult: number, equity: number | null): Promise<void> {
    const name = st.spec.name;
    const rawBook = this.ex.getBook(name);
    const price = this.ex.getPrice(name);
    const book = stripOwn(rawBook, st.live);
    const fair = microprice(book) ?? price?.mid ?? null;
    if (fair !== null) {
      this.lastMid.set(name, fair);
      st.samples.push({ ts: now, mid: fair });
      const cutoff = now - this.cfg.engine.volWindowMs;
      while (st.samples.length > 2 && st.samples[0]!.ts < cutoff) st.samples.shift();
    }

    // Circuit breaker first: it can pull quotes even when ordinary risk checks are happy.
    const bb = rawBook?.bids[0]?.price;
    const ba = rawBook?.asks[0]?.price;
    const mid = bb !== undefined && ba !== undefined ? (bb + ba) / 2 : null;
    const fz = st.fuse.observe(now, {
      fair,
      spreadBps: mid !== null && bb !== undefined && ba !== undefined ? ((ba - bb) / mid) * 1e4 : null,
      oracleDevBps: mid !== null && price && price.oracle > 0 ? (Math.abs(mid - price.oracle) / price.oracle) * 1e4 : null,
    });
    st.fuseStatus = fz;
    if (fz.state === "halt") {
      this.log("error", "HALT", { market: name, reason: fz.reason });
      await this.haltAll();
      return;
    }
    if (fz.state === "tripped") {
      if (fz.justTripped) {
        this.tripCount++;
        this.log("warn", "FUSE tripped: pulling quotes", { market: name, reason: fz.reason, pauseSec: Math.round((fz.until - now) / 1000) });
      }
      if (st.live) {
        await this.ex.cancelAll(name);
        st.live = st.placed = null;
      }
      st.dirty = true;
      return;
    }
    const widen = fz.state === "recovering" ? fz.widen : 1;

    const scale = this.ramp.mult;
    const size = this.sizeOf(st, equity, scale);
    st.sizeNow = size;
    const maxPos = size.maxPos;
    const position = this.ex.getPosition(name);
    const posUsd = fair !== null ? position * fair : 0;
    const risk = assess(
      {
        ...this.risk,
        emergencyPositionUsd: maxPos * this.cfg.risk.emergencyPositionMult,
        reduceToUsd: maxPos * this.cfg.risk.reduceToMult,
      },
      {
        now,
        book: rawBook,
        price,
        positionUsd: posUsd,
        equityUsd: equity,
        startEquityUsd: this.startEquity,
        consecutiveFailures: st.failures,
        cooldownUntil: st.cooldownUntil,
        killSwitch: this.opts.killSwitch?.() ?? false,
      },
    );

    if (risk.kind === "halt") {
      this.log("error", "HALT", { market: name, reason: risk.reason });
      await this.haltAll();
      return;
    }
    if (risk.kind === "pause") {
      if (st.lastPause !== risk.reason) this.log("warn", "pause", { market: name, reason: risk.reason });
      st.lastPause = risk.reason;
      if (st.live) {
        await this.ex.cancelAll(name);
        st.live = st.placed = null;
        st.dirty = true;
      }
      return;
    }
    st.lastPause = null;

    if (risk.kind === "reduce" && fair !== null && !this.holdTakerReduce(posUsd, maxPos)) {
      const size = roundDownToStep(Math.min(risk.sizeUsd / fair, Math.abs(position)), st.spec.lotSize);
      if (size >= st.spec.minSize) {
        const slip = 10 / 1e4;
        const limitPrice = risk.side === "buy" ? fair * (1 + slip) : fair * (1 - slip);
        this.log("warn", "reduce", { market: name, side: risk.side, size, reason: risk.reason });
        this.lastReduceAt.set(name, now);
        await this.ex.reduce({ market: name, side: risk.side, size, limitPrice });
        st.dirty = true;
      }
      return;
    }
    // (When holdTakerReduce is true the one-sided quotes below keep working the position down as a maker.)
    if (fair === null) return;

    if (!st.warnedTooSmall && size.level / fair < st.spec.minSize) {
      st.warnedTooSmall = true;
      this.log("warn", "level size is below the market minimum, no quotes until the size grows (ramp stage or equity)", { market: name, sizeMult: scale, levelUsd: round(size.level, 2), capUsd: round(size.maxPos, 2) });
    }

    const qp = this.quoteParams(st, mult * widen, size);
    qp.guardTicks = this.guardTicks(now);
    const target = buildLadder({ spec: st.spec, fair, position, book, params: qp });

    const empty = target.bids.length + target.asks.length === 0;
    const threatened = isLadderThreatened(st.placed, rawBook, this.cfg.engine.threatBps);
    st.urgentBps = this.urgentThresholdBps(qp, target);
    const urgent = topDriftBps(st.placed, target) >= st.urgentBps;
    const due = now - st.lastReplaceAt >= st.nextInterval * this.economy;
    const stale = needsReplace(st.placed, target, this.cfg.engine);

    if (!(st.dirty || stale || threatened || urgent)) return;
    if (!due && !threatened && !urgent && st.live) return;
    // Hard cap on transaction rate: every replace costs gas.
    if (st.live && now - st.lastReplaceAt < this.cfg.engine.hardMinReplaceIntervalMs) return;

    const reason: ReplaceReason = !st.live ? "initial" : threatened ? "threat" : urgent ? "drift" : st.dirty ? "fill" : "stale";
    const ok = empty ? await this.ex.cancelAll(name) : await this.ex.replaceLadder(name, target);
    st.lastReplaceAt = now;
    const j = this.cfg.engine.jitterPct;
    st.nextInterval = this.cfg.engine.minReplaceIntervalMs * (1 + (this.rng() * 2 - 1) * j);
    this.replaceCounts[reason]++;
    this.replaceTimes.push(now);
    if (ok) {
      st.live = empty ? null : cloneLadder(target);
      st.placed = empty ? null : cloneLadder(target);
      st.dirty = false;
      st.failures = 0;
    } else {
      st.failures++;
      st.dirty = true;
      this.log("warn", "replace failed", { market: name, failures: st.failures });
      if (st.failures >= this.cfg.risk.maxConsecutiveFailures) {
        st.cooldownUntil = now + this.cfg.risk.cooldownMs;
        st.failures = 0;
        this.log("error", "cool-down after repeated tx failures", { market: name, ms: this.cfg.risk.cooldownMs });
      }
    }
  }

  /** Rebate we can count on: only while the cycle maker ratio is at (or has no reason to fall below) the threshold. */
  private expectedRebateBps(): number {
    const r = this.cfg.rebate;
    if (!r.enabled) return 0;
    const ratio = this.points.stats(this.clock).cycleMakerRatio;
    return ratio === null || ratio >= r.minMakerRatio ? r.bps : 0;
  }

  /**
   * Position cap and first-level size for a market, in USD. Fixed from the config unless `sizing.leverage` is set,
   * in which case they follow equity (the configured numbers act as ceilings). `scale` is the ramp stage.
   */
  private sizeOf(st: MarketState, equity: number | null, scale: number): { maxPos: number; level: number } {
    const z = this.cfg.sizing;
    let cap = st.cfg.maxPositionUsd;
    let level = st.cfg.levelSizeUsd;
    if (z.leverage > 0 && equity !== null && equity > 0) {
      if (this.sizingEquity === null || Math.abs(equity - this.sizingEquity) / this.sizingEquity > z.rebalanceTol) this.sizingEquity = equity;
      cap = Math.min(cap, (this.sizingEquity * z.leverage) / this.states.size);
      level = Math.min(level, cap * z.levelFraction);
    }
    return { maxPos: cap * scale, level: level * scale };
  }

  private quoteParams(st: MarketState, mult: number, size: { maxPos: number; level: number }): QuoteParams {
    const c = st.cfg;
    const fee = this.ex.getFees?.();
    return {
      levels: c.levels,
      baseHalfSpreadBps: c.baseHalfSpreadBps,
      levelStepBps: c.levelStepBps,
      levelSizeUsd: size.level,
      sizeGrowth: c.sizeGrowth,
      inventorySkewBps: c.inventorySkewBps,
      maxPositionUsd: size.maxPos,
      minHalfSpreadBps: c.minHalfSpreadBps,
      spreadMult: mult,
      volBps: realizedVolBps(st.samples),
      volK: c.volK,
      competition: {
        joinTouch: this.cfg.competition.joinTouch,
        improveTicks: this.cfg.competition.improveTicks,
        makerFeeBps: Math.max(0, (fee ? fee.maker * 1e4 : this.cfg.competition.makerFeeBps) - this.expectedRebateBps()),
        maxCostBps: this.cfg.points.costBudgetBps,
      },
    };
  }

  private async housekeeping(now: number): Promise<void> {
    const e = this.cfg.engine;
    if (now - this.lastStatus >= e.statusEveryMs) {
      this.lastStatus = now;
      this.log("info", "status", this.statusFields(now));
      const runway = this.gasRunwayDays(now, this.ex.getGas?.() ?? null);
      if (runway !== null && runway < 3 && now - this.lastRunwayWarn >= HOUR_MS) {
        this.lastRunwayWarn = now;
        this.log(runway < 1 ? "error" : "warn", "APT for gas is running low: top up the signer account", { daysLeft: runway, balanceApt: this.ex.getGas?.()?.balanceApt ?? null });
      }
    }
    if (this.opts.persist && e.liveFile && now - this.lastLive >= e.liveEveryMs) {
      this.lastLive = now;
      this.writeLive(now);
    }
    if (this.ex.getPoints && now - this.lastPointsPoll >= e.pointsPollEveryMs) {
      this.lastPointsPoll = now;
      void this.pollPoints(now);
    }
    if (this.opts.persist && now - this.lastSave >= 15_000) {
      this.lastSave = now;
      this.save(now);
    }
  }

  /** What the live file holds: the status numbers plus a view of every market. */
  snapshot(now: number): Record<string, unknown> {
    return { ...this.statusFields(now), markets: this.marketViews() };
  }

  /** The numbers behind every `status` log line (and the live snapshot). */
  private statusFields(now: number): Record<string, unknown> {
    const s = this.points.stats(now);
    const gasNow = this.ex.getGas?.() ?? null;
    const names = [...this.states.keys()];
    const positions = Object.fromEntries(names.map((n) => [n, round(this.ex.getPosition(n), 6)]));
    const fuses = Object.fromEntries([...this.states.entries()].map(([n, st]) => [n, st.fuse.tripsInLastHour]));
    const mids = Object.fromEntries(names.map((n) => [n, round(this.lastMid.get(n) ?? NaN, 4)]));
    const positionsUsd = Object.fromEntries(
      names.map((n) => [n, round(this.ex.getPosition(n) * (this.lastMid.get(n) ?? NaN), 2)]),
    );
    const quoting = Object.fromEntries([...this.states.entries()].map(([n, st]) => [n, st.live !== null]));
    const paused = Object.fromEntries([...this.states.entries()].map(([n, st]) => [n, st.lastPause]));
    return {
      equity: round(this.ex.getAccount()?.equityUsd ?? NaN, 2),
      startEquity: round(this.startEquity ?? NaN, 2),
      dayVolumeUsd: Math.round(s.dayVolumeUsd),
      makerShare: s.dayVolumeUsd > 0 ? round(s.dayMakerVolumeUsd / s.dayVolumeUsd, 3) : null,
      pnlBps: round(s.ewmaPnlBps, 3),
      spreadMult: round(s.spreadMult, 3),
      volumeFrac: round(s.volumeFrac, 3),
      streakSecured: s.streakSecured,
      rampStage: this.ramp.stage,
      sizeMult: this.ramp.mult,
      phase: this.phase,
      takerFills: this.takerFills,
      takerReduce: this.takerReduce,
      takerCross: this.takerCross,
      guardTicks: this.guardTicks(now),
      replaces: { ...this.replaceCounts },
      replacesLastHour: this.replacesLastHour(now),
      economy: round(this.economy, 2),
      lossPace: round(this.lossPaceMult, 2),
      aptUsd: this.aptUsdNow(),
      gasUsd: round(s.dayGasUsd, 4),
      gasBps: s.dayVolumeUsd > 0 ? round((s.dayGasUsd / s.dayVolumeUsd) * 1e4, 3) : null,
      gasRunwayDays: this.gasRunwayDays(now, gasNow),
      gasPerTxApt: gasNow?.byPath
        ? { encrypted: gasNow.byPath.encrypted.avgApt === null ? null : round(gasNow.byPath.encrypted.avgApt, 6), plain: gasNow.byPath.plain.avgApt === null ? null : round(gasNow.byPath.plain.avgApt, 6), encryptedTx: gasNow.byPath.encrypted.tx, plainTx: gasNow.byPath.plain.tx }
        : null,
      cycle: s.cycleKey,
      cycleMakerRatio: s.cycleMakerRatio === null ? null : round(s.cycleMakerRatio, 3),
      rebateEligible: s.cycleMakerRatio === null || s.cycleMakerRatio >= this.cfg.rebate.minMakerRatio,
      projectedRebateUsd: round((s.cycleMakerVolumeUsd * this.cfg.rebate.bps) / 1e4, 4),
      fuseTripsLastHour: fuses,
      fuseTrips: this.tripCount,
      positions,
      positionsUsd,
      mids,
      quoting,
      paused,
      ...(gasNow ? { txCount: gasNow.txCount, gasApt: round(gasNow.gasApt, 6), signerAptBalance: gasNow.balanceApt === null ? null : round(gasNow.balanceApt, 4) } : {}),
    };
  }

  private replacesLastHour(now: number): number {
    this.replaceTimes = this.replaceTimes.filter((t) => now - t < HOUR_MS);
    return this.replaceTimes.length;
  }

  /** Days the signer's APT balance lasts at this process's average burn; null until there is half an hour of data. */
  private gasRunwayDays(now: number, gas: { gasApt: number; balanceApt: number | null } | null): number | null {
    if (!gas || gas.balanceApt === null || this.startedAt === null) return null;
    const days = (now - this.startedAt) / DAY_MS;
    if (days < 1800_000 / DAY_MS || !(gas.gasApt > 0)) return null;
    return round(gas.balanceApt / (gas.gasApt / days), 1);
  }

  /** Per-market view for the dashboard: top of book, position, resting quotes, fuse. */
  private marketViews(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, st] of this.states) {
      const book = this.ex.getBook(name);
      const bid = book?.bids[0]?.price ?? null;
      const ask = book?.asks[0]?.price ?? null;
      const mid = this.lastMid.get(name) ?? null;
      const pos = this.ex.getPosition(name);
      const f = st.fuseStatus;
      out[name] = {
        mid: mid === null ? null : round(mid, 4),
        bid,
        ask,
        spreadBps: bid !== null && ask !== null && bid > 0 ? round(((ask - bid) / ((ask + bid) / 2)) * 1e4, 3) : null,
        position: round(pos, 6),
        positionUsd: mid === null ? null : round(pos * mid, 2),
        quoting: st.live !== null,
        paused: st.lastPause,
        fuse: f.state,
        fuseUntil: f.state === "tripped" ? f.until : null,
        fuseReason: f.state === "tripped" || f.state === "halt" ? f.reason : null,
        quotes: st.live ? { bids: st.live.bids.map((q) => [q.price, q.size]), asks: st.live.asks.map((q) => [q.price, q.size]) } : null,
        lastReplaceAt: st.lastReplaceAt || null,
        urgentBps: round(st.urgentBps, 2),
        capUsd: st.sizeNow ? round(st.sizeNow.maxPos, 2) : null,
        levelUsd: st.sizeNow ? round(st.sizeNow.level, 2) : null,
      };
    }
    return out;
  }

  /** Latest snapshot for the dashboard, replaced atomically so a reader never sees half a file. */
  private writeLive(now: number): void {
    const file = this.cfg.engine.liveFile;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ t: new Date().toISOString(), now, pid: process.pid, endsAt: this.opts.endsAt ?? null, ...this.snapshot(now) }));
      renameSync(tmp, file);
    } catch (err) {
      if (!this.liveWarned) {
        this.liveWarned = true;
        this.log("warn", "live snapshot write failed (dashboard falls back to the log)", { error: String(err) });
      }
    }
  }

  /** Append one research row: how many Amps did today's volume actually earn at this cost? */
  private async pollPoints(now: number): Promise<void> {
    try {
      const snap = await this.ex.getPoints?.();
      if (!snap) return;
      const s = this.points.stats(now);
      const row = {
        ts: new Date(now).toISOString(),
        dayVolumeUsd: round(s.dayVolumeUsd, 2),
        makerVolumeUsd: round(s.dayMakerVolumeUsd, 2),
        ampsToday: snap.ampsToday,
        totalPoints: snap.totalPoints ?? null,
        makerFraction: snap.makerFraction ?? null,
        cycleMakerRatio: s.cycleMakerRatio === null ? null : round(s.cycleMakerRatio, 4),
        cycleMakerVolumeUsd: round(s.cycleMakerVolumeUsd, 2),
        rebateEarnedUsd: snap.rebateEarnedUsd ?? null,
        rebateReadyUsd: snap.rebateReadyUsd ?? null,
        tradingAmpsToday: snap.tradingAmpsToday,
        streakAmpsToday: snap.streakAmpsToday,
        currentStreak: snap.currentStreak,
        tier: snap.tier,
        ampsPerMillionUsd: snap.tradingAmpsToday !== null && s.dayVolumeUsd > 0 ? round((snap.tradingAmpsToday / s.dayVolumeUsd) * 1e6, 2) : null,
        spreadMult: round(s.spreadMult, 3),
        pnlBps: round(s.ewmaPnlBps, 3),
        makerFeeRate: snap.makerFeeRate,
        takerFeeRate: snap.takerFeeRate,
        volume30dUsd: snap.volume30dUsd,
      };
      this.log("info", "points", row);
      if ((snap.rebateReadyUsd ?? 0) > 0) this.log("info", "maker rebate ready to claim: open Rewards in the app", { usd: snap.rebateReadyUsd });
      const file = this.cfg.engine.pointsLogFile;
      mkdirSync(dirname(file), { recursive: true });
      const header = Object.keys(row).join(",") + "\n";
      if (!existsSync(file)) writeFileSync(file, header);
      appendFileSync(file, Object.values(row).map((v) => (v === null ? "" : String(v))).join(",") + "\n");
    } catch (e) {
      this.log("warn", "points poll failed", { error: String(e) });
    }
  }

  private save(now: number): void {
    try {
      const s = this.points.stats(now);
      const file = this.cfg.engine.stateFile;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          dayKey: s.dayKey,
          dayVolumeUsd: s.dayVolumeUsd,
          spreadMult: s.spreadMult,
          rampStage: this.ramp.stage,
          cycleKey: s.cycleKey,
          cycleMakerUsd: s.cycleMakerVolumeUsd,
          cycleTakerUsd: s.cycleTakerVolumeUsd,
          dayStartKey: this.dayStart?.key ?? null,
          dayStartEquity: this.dayStart?.equity ?? null,
          dailyPausedDay: this.dailyPausedDay,
          gasDay: this.gasDay,
          gasSpentApt: this.lastGasApt === null || this.gasDay === "" ? this.gasCarryApt : this.gasSpentToday(this.lastGasApt),
        }),
      );
    } catch (e) {
      this.log("warn", "state save failed", { error: String(e) });
    }
  }

  private restore(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cfg.engine.stateFile, "utf8"));
      if (raw.dayKey === new Date().toISOString().slice(0, 10)) this.points.restore(raw);
      // The daily loss baseline and a pause already in force survive a restart on the same UTC day.
      const today = new Date().toISOString().slice(0, 10);
      if (raw.dayStartKey === today && Number.isFinite(raw.dayStartEquity)) this.dayStart = { key: today, equity: Number(raw.dayStartEquity) };
      if (raw.dailyPausedDay === today) {
        this.dailyPausedDay = today;
        this.phase = "paused";
      }
      // Gas spent earlier today by a process that has since restarted still counts against today's budget.
      if (raw.gasDay === new Date().toISOString().slice(0, 10) && Number.isFinite(raw.gasSpentApt)) this.gasCarryApt = Math.max(0, Number(raw.gasSpentApt));
      // The ramp stage is earned over days, so it survives day changes.
      if (typeof raw.rampStage === "number") this.ramp.restoreStage(raw.rampStage);
      if (typeof raw.cycleKey === "string") this.points.restoreCycle({ cycleKey: raw.cycleKey, makerUsd: Number(raw.cycleMakerUsd) || 0, takerUsd: Number(raw.cycleTakerUsd) || 0 }, Date.now());
    } catch {
      /* no prior state */
    }
  }

  /**
   * Stop quoting, pull every resting order and close every open position with reduce-only IOC orders,
   * widening the price limit on each retry. A reduce-only order can never open or flip a position, so
   * repeating an attempt while the position reading lags is safe. Never throws: the outcome is returned.
   */
  async flattenAll(o: { attempts?: number } = {}): Promise<FlattenResult> {
    this.halted = true; // step() stops placing quotes
    this.phase = "flattening";
    await this.cancelAll();
    const res = await this.closeOut(o.attempts);
    this.phase = "done";
    if (this.opts.persist && this.cfg.engine.liveFile) this.writeLive(Date.now());
    return res;
  }

  /** Close every open position with reduce-only IOC orders (the quotes must already be off). Does not stop the engine. */
  private async closeOut(attemptsWanted?: number): Promise<FlattenResult> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let orders = 0;

    const open = () => {
      const out: { name: string; st: MarketState; pos: number; size: number }[] = [];
      for (const [name, st] of this.states) {
        const pos = this.ex.getPosition(name);
        const size = roundDownToStep(Math.abs(pos), st.spec.lotSize);
        if (size >= st.spec.minSize) out.push({ name, st, pos, size });
      }
      return out;
    };

    const attempts = Math.min(attemptsWanted ?? FLATTEN_SLIPPAGE_BPS.length, FLATTEN_SLIPPAGE_BPS.length);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const todo = open();
      if (todo.length === 0) break;
      const slip = FLATTEN_SLIPPAGE_BPS[attempt]! / 1e4;
      this.log("info", "flatten: attempt", { attempt: attempt + 1, slippageBps: FLATTEN_SLIPPAGE_BPS[attempt], positions: Object.fromEntries(todo.map((t) => [t.name, t.pos])) });
      for (const { name, pos, size } of todo) {
        const book = this.ex.getBook(name);
        const touch = pos > 0 ? book?.bids[0]?.price : book?.asks[0]?.price;
        const ref = touch ?? this.lastMid.get(name) ?? this.ex.getPrice(name)?.mid;
        if (!ref || ref <= 0) {
          this.log("error", "flatten: no price for market, cannot close", { market: name });
          continue;
        }
        const side = pos > 0 ? "sell" : "buy";
        const limitPrice = side === "sell" ? ref * (1 - slip) : ref * (1 + slip);
        this.log("info", "flatten: order", { market: name, side, size: round(size, 8), ref, limitPrice: round(limitPrice, 4) });
        this.lastReduceAt.set(name, this.clock);
        try {
          if (await this.ex.reduce({ market: name, side, size, limitPrice })) orders++;
        } catch (e) {
          this.log("error", "flatten: order failed", { market: name, error: String(e) });
        }
      }
      // Positions are read on a timer, so give the venue a few seconds to show the result.
      for (let w = 0; w < 16 && open().length > 0; w++) {
        await sleep(500);
        if (this.opts.persist && this.cfg.engine.liveFile) this.writeLive(Date.now());
      }
    }

    const residual: Record<string, number> = {};
    const dust: Record<string, number> = {};
    for (const [name, st] of this.states) {
      const pos = this.ex.getPosition(name);
      if (Math.abs(pos) < 1e-12) continue;
      if (roundDownToStep(Math.abs(pos), st.spec.lotSize) >= st.spec.minSize) residual[name] = round(pos, 8);
      else dust[name] = round(pos, 8);
    }
    const closed = Object.keys(residual).length === 0;
    this.log(closed ? "info" : "error", closed ? "flatten: done" : "flatten: INCOMPLETE, positions remain", { residual, dust, orders });
    return { closed, residual, dust, orders };
  }

  async haltAll(): Promise<void> {
    this.halted = true;
    await this.cancelAll();
  }

  /** Pull every resting quote. Called on shutdown and on halt. */
  async cancelAll(): Promise<void> {
    for (const st of this.states.values()) {
      try {
        await this.ex.cancelAll(st.spec.name);
        st.live = st.placed = null;
      } catch (e) {
        this.log("error", "cancelAll failed", { market: st.spec.name, error: String(e) });
      }
    }
  }
}

/**
 * Take a fill off the ladder we believe is resting, so that it keeps matching the venue: a filled level must not go on
 * being subtracted from the book as "our" size (that made other people's orders at the same price vanish from our view
 * of the touch) nor count as the top of our ladder when measuring how stale it is.
 */
export function applyFillToLadder(live: Ladder | null, f: { side: "buy" | "sell"; price: number; size: number }, spec: MarketSpec): void {
  if (!live) return;
  const list = f.side === "buy" ? live.bids : live.asks;
  const i = list.findIndex((q) => Math.abs(q.price - f.price) < spec.tickSize / 2);
  if (i < 0) return;
  const q = list[i]!;
  q.size = Number((q.size - f.size).toFixed(Math.max(spec.szDecimals, 8)));
  if (q.size < spec.lotSize / 2) list.splice(i, 1);
}

function cloneLadder(l: Ladder): Ladder {
  return { bids: l.bids.map((x) => ({ ...x })), asks: l.asks.map((x) => ({ ...x })) };
}

/** Std-dev of per-sample returns, scaled to a 1-second horizon, in bps. */
export function realizedVolBps(samples: { ts: number; mid: number }[]): number {
  if (samples.length < 5) return 0;
  const rets: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dt = (b.ts - a.ts) / 1000;
    if (dt <= 0) continue;
    rets.push(Math.log(b.mid / a.mid) / Math.sqrt(dt));
  }
  if (rets.length < 4) return 0;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const v = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * 1e4;
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}
