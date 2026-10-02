import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config, MarketConfig } from "./config.js";
import type { Exchange } from "./exchange/exchange.js";
import { VolatilityFuse } from "./strategy/fuse.js";
import type { FuseStatus } from "./strategy/fuse.js";
import { PointsController } from "./strategy/points.js";
import { RampController } from "./strategy/ramp.js";
import {
  buildLadder,
  isLadderThreatened,
  microprice,
  needsReplace,
  roundDownToStep,
  stripOwn,
  topDriftBps,
} from "./strategy/quoter.js";
import type { QuoteParams } from "./strategy/quoter.js";
import { assess } from "./strategy/risk.js";
import type { RiskConfig } from "./strategy/risk.js";
import type { Ladder, MarketSpec } from "./types.js";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

let runLogFile: string | null = null;

/** Also append every log line to this file (the dashboard reads it). null/empty = stdout only. */
export function setRunLogFile(path: string | null): void {
  runLogFile = path || null;
  if (runLogFile) mkdirSync(dirname(runLogFile), { recursive: true });
}

export const jsonLogger: Logger = (level, msg, extra) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  console.log(line);
  if (!runLogFile) return;
  try {
    appendFileSync(runLogFile, line + "\n");
  } catch {
    // Logging must never be able to stop the bot.
  }
};

interface MarketState {
  spec: MarketSpec;
  cfg: MarketConfig;
  live: Ladder | null;
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
}

export interface EngineOpts {
  /** Returns true when the operator wants everything stopped (e.g. KILL file exists). */
  killSwitch?: () => boolean;
  log?: Logger;
  /** Persist/restore the daily counters across restarts. */
  persist?: boolean;
  /** Source of randomness in [0,1) for refresh-interval jitter; injectable for tests. */
  rng?: () => number;
}

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
      this.fillCount++;
      if (!f.isMaker) {
        this.takerFills++;
        this.log("warn", "taker fill: paid the taker fee and lowered the maker share", { market: f.market, px: f.price, sz: f.size });
      }
      this.points.onFill(f, this.lastMid.get(f.market) ?? f.price);
      this.log("info", "fill", { market: f.market, side: f.side, px: f.price, sz: f.size, maker: f.isMaker, fee: round(f.feeUsd, 4) });
    }
    this.points.tick(now, (m) => this.lastMid.get(m));
    await this.checkToxicFlow(now);
    if (this.halted) return;

    const acct = this.ex.getAccount();
    if (acct && this.startEquity === null) this.startEquity = acct.equityUsd;

    const gas = this.ex.getGas?.() ?? null;
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

    const mult = this.points.spreadMult(now);

    for (const st of this.states.values()) {
      await this.stepMarket(st, now, mult, acct?.equityUsd ?? null);
      if (this.halted) return;
    }

    await this.housekeeping(now);
  }

  /** True when a taker reduce should wait: it would cost the rebate and the position is not yet extreme. */
  private holdTakerReduce(posUsd: number, maxPos: number): boolean {
    const r = this.cfg.rebate;
    if (!r.enabled) return false;
    const ratio = this.points.stats(this.clock).cycleMakerRatio;
    if (ratio === null || ratio > r.minMakerRatio + r.ratioBuffer) return false;
    return Math.abs(posUsd) <= maxPos * this.cfg.risk.emergencyPositionMult * 2;
  }

  /** Pull quotes for the rest of the UTC day once the gas budget is spent. */
  private async gasBudgetExceeded(now: number, gasApt: number): Promise<boolean> {
    const day = utcDay(now);
    if (day !== this.gasDay) {
      this.gasDay = day;
      this.gasDayBase = gasApt;
      this.gasPausedDay = null;
    }
    if (this.gasPausedDay === day) return true;
    const spent = gasApt - this.gasDayBase;
    if (spent < this.cfg.risk.maxGasAptPerDay) return false;
    this.gasPausedDay = day;
    this.log("error", "gas budget for the day spent; pulling quotes until tomorrow (UTC)", { spentApt: round(spent, 6), maxGasAptPerDay: this.cfg.risk.maxGasAptPerDay });
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
        st.live = null;
      }
      st.dirty = true;
      return;
    }
    const widen = fz.state === "recovering" ? fz.widen : 1;

    const scale = this.ramp.mult;
    const maxPos = st.cfg.maxPositionUsd * scale;
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
        st.live = null;
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
        await this.ex.reduce({ market: name, side: risk.side, size, limitPrice });
        st.dirty = true;
      }
      return;
    }
    // (When holdTakerReduce is true the one-sided quotes below keep working the position down as a maker.)
    if (fair === null) return;

    if (!st.warnedTooSmall && st.cfg.levelSizeUsd * scale / fair < st.spec.minSize) {
      st.warnedTooSmall = true;
      this.log("warn", "ramp stage too small: level size is below the market minimum, no quotes until the stage grows", { market: name, sizeMult: scale });
    }

    const target = buildLadder({
      spec: st.spec,
      fair,
      position,
      book,
      params: this.quoteParams(st, mult * widen, scale),
    });

    const empty = target.bids.length + target.asks.length === 0;
    const threatened = isLadderThreatened(st.live, rawBook, this.cfg.engine.threatBps);
    const urgent = topDriftBps(st.live, target) >= this.cfg.engine.urgentRepriceBps;
    const due = now - st.lastReplaceAt >= st.nextInterval;
    const stale = needsReplace(st.live, target, this.cfg.engine);

    if (!(st.dirty || stale || threatened || urgent)) return;
    if (!due && !threatened && !urgent && st.live) return;
    // Hard cap on transaction rate: every replace costs gas.
    if (st.live && now - st.lastReplaceAt < this.cfg.engine.hardMinReplaceIntervalMs) return;

    const ok = empty ? await this.ex.cancelAll(name) : await this.ex.replaceLadder(name, target);
    st.lastReplaceAt = now;
    const j = this.cfg.engine.jitterPct;
    st.nextInterval = this.cfg.engine.minReplaceIntervalMs * (1 + (this.rng() * 2 - 1) * j);
    if (ok) {
      st.live = empty ? null : cloneLadder(target);
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

  private quoteParams(st: MarketState, mult: number, scale: number): QuoteParams {
    const c = st.cfg;
    const fee = this.ex.getFees?.();
    return {
      levels: c.levels,
      baseHalfSpreadBps: c.baseHalfSpreadBps,
      levelStepBps: c.levelStepBps,
      levelSizeUsd: c.levelSizeUsd * scale,
      sizeGrowth: c.sizeGrowth,
      inventorySkewBps: c.inventorySkewBps,
      maxPositionUsd: c.maxPositionUsd * scale,
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
      takerFills: this.takerFills,
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
      writeFileSync(tmp, JSON.stringify({ t: new Date().toISOString(), now, pid: process.pid, ...this.statusFields(now), markets: this.marketViews() }));
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
      // The ramp stage is earned over days, so it survives day changes.
      if (typeof raw.rampStage === "number") this.ramp.restoreStage(raw.rampStage);
      if (typeof raw.cycleKey === "string") this.points.restoreCycle({ cycleKey: raw.cycleKey, makerUsd: Number(raw.cycleMakerUsd) || 0, takerUsd: Number(raw.cycleTakerUsd) || 0 }, Date.now());
    } catch {
      /* no prior state */
    }
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
        st.live = null;
      } catch (e) {
        this.log("error", "cancelAll failed", { market: st.spec.name, error: String(e) });
      }
    }
  }
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
