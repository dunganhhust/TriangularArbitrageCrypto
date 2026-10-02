import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config, MarketConfig } from "./config.js";
import type { Exchange } from "./exchange/exchange.js";
import { PointsController } from "./strategy/points.js";
import { buildLadder, isLadderThreatened, microprice, needsReplace, roundDownToStep, stripOwn } from "./strategy/quoter.js";
import type { QuoteParams } from "./strategy/quoter.js";
import { assess } from "./strategy/risk.js";
import type { RiskConfig } from "./strategy/risk.js";
import type { Ladder, MarketSpec } from "./types.js";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export const jsonLogger: Logger = (level, msg, extra) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
};

interface MarketState {
  spec: MarketSpec;
  cfg: MarketConfig;
  live: Ladder | null;
  lastReplaceAt: number;
  dirty: boolean;
  samples: { ts: number; mid: number }[];
  failures: number;
  cooldownUntil: number;
  lastPause: string | null;
}

export interface EngineOpts {
  /** Returns true when the operator wants everything stopped (e.g. KILL file exists). */
  killSwitch?: () => boolean;
  log?: Logger;
  /** Persist/restore the daily counters across restarts. */
  persist?: boolean;
}

export class MarketMaker {
  readonly points: PointsController;
  private readonly states = new Map<string, MarketState>();
  private readonly risk: RiskConfig;
  private readonly log: Logger;
  private startEquity: number | null = null;
  private lastStatus = 0;
  private lastPointsPoll = 0;
  private lastSave = 0;
  private halted = false;
  private lastMid = new Map<string, number>();

  constructor(
    private readonly cfg: Config,
    private readonly ex: Exchange,
    specs: MarketSpec[],
    private readonly opts: EngineOpts = {},
  ) {
    this.log = opts.log ?? jsonLogger;
    this.points = new PointsController(cfg.points);
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
        dirty: true,
        samples: [],
        failures: 0,
        cooldownUntil: 0,
        lastPause: null,
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

    for (const f of this.ex.drainFills()) {
      const st = this.states.get(f.market);
      if (!st) continue;
      st.dirty = true; // resting sizes changed; re-send the full ladder
      this.points.onFill(f, this.lastMid.get(f.market) ?? f.price);
      this.log("info", "fill", { market: f.market, side: f.side, px: f.price, sz: f.size, maker: f.isMaker, fee: round(f.feeUsd, 4) });
    }
    this.points.tick(now, (m) => this.lastMid.get(m));

    const acct = this.ex.getAccount();
    if (acct && this.startEquity === null) this.startEquity = acct.equityUsd;

    const mult = this.points.spreadMult(now);

    for (const st of this.states.values()) {
      await this.stepMarket(st, now, mult, acct?.equityUsd ?? null);
      if (this.halted) return;
    }

    await this.housekeeping(now);
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

    const position = this.ex.getPosition(name);
    const posUsd = fair !== null ? position * fair : 0;
    const risk = assess(
      {
        ...this.risk,
        emergencyPositionUsd: st.cfg.maxPositionUsd * this.cfg.risk.emergencyPositionMult,
        reduceToUsd: st.cfg.maxPositionUsd * this.cfg.risk.reduceToMult,
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

    if (risk.kind === "reduce" && fair !== null) {
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
    if (fair === null) return;

    const target = buildLadder({
      spec: st.spec,
      fair,
      position,
      book,
      params: this.quoteParams(st, mult),
    });

    const empty = target.bids.length + target.asks.length === 0;
    const threatened = isLadderThreatened(st.live, rawBook, this.cfg.engine.threatBps);
    const due = now - st.lastReplaceAt >= this.cfg.engine.minReplaceIntervalMs;
    const stale = needsReplace(st.live, target, this.cfg.engine);

    if (!(st.dirty || stale || threatened)) return;
    if (!due && !threatened && st.live) return;

    const ok = empty ? await this.ex.cancelAll(name) : await this.ex.replaceLadder(name, target);
    st.lastReplaceAt = now;
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

  private quoteParams(st: MarketState, mult: number): QuoteParams {
    const c = st.cfg;
    return {
      levels: c.levels,
      baseHalfSpreadBps: c.baseHalfSpreadBps,
      levelStepBps: c.levelStepBps,
      levelSizeUsd: c.levelSizeUsd,
      sizeGrowth: c.sizeGrowth,
      inventorySkewBps: c.inventorySkewBps,
      maxPositionUsd: c.maxPositionUsd,
      minHalfSpreadBps: c.minHalfSpreadBps,
      spreadMult: mult,
      volBps: realizedVolBps(st.samples),
      volK: c.volK,
    };
  }

  private async housekeeping(now: number): Promise<void> {
    const e = this.cfg.engine;
    if (now - this.lastStatus >= e.statusEveryMs) {
      this.lastStatus = now;
      const s = this.points.stats(now);
      const positions = Object.fromEntries(
        [...this.states.keys()].map((n) => [n, round(this.ex.getPosition(n), 6)]),
      );
      this.log("info", "status", {
        equity: round(this.ex.getAccount()?.equityUsd ?? NaN, 2),
        dayVolumeUsd: Math.round(s.dayVolumeUsd),
        makerShare: s.dayVolumeUsd > 0 ? round(s.dayMakerVolumeUsd / s.dayVolumeUsd, 3) : null,
        pnlBps: round(s.ewmaPnlBps, 3),
        spreadMult: round(s.spreadMult, 3),
        volumeFrac: round(s.volumeFrac, 3),
        streakSecured: s.streakSecured,
        positions,
      });
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
      writeFileSync(file, JSON.stringify({ dayKey: s.dayKey, dayVolumeUsd: s.dayVolumeUsd, spreadMult: s.spreadMult }));
    } catch (e) {
      this.log("warn", "state save failed", { error: String(e) });
    }
  }

  private restore(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cfg.engine.stateFile, "utf8"));
      if (raw.dayKey === new Date().toISOString().slice(0, 10)) this.points.restore(raw);
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
