import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { MarketMaker, applyFillToLadder } from "../src/engine.js";
import type { Logger } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";
import { PointsController } from "../src/strategy/points.js";
import { buildLadder, halfSpreadBps, topLevelUsd } from "../src/strategy/quoter.js";
import type { QuoteParams } from "../src/strategy/quoter.js";
import type { Fill, Ladder, MarketSpec } from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1, 6);
const NAME = "ETH/USD";

function config(over: Record<string, unknown> = {}) {
  return configSchema.parse({
    markets: [{ name: NAME, maxPositionUsd: 100, levelSizeUsd: 30, levels: 3 }],
    ramp: { enabled: false },
    paper: { startMid: 2700, annualVolPct: 5, flowPerSec: 0.001, equityUsd: 20, seed: 11, gasAptPerTx: 0.0005 },
    ...over,
  });
}

async function build(over: Record<string, unknown> = {}, opts: { apt?: number | null } = {}) {
  const cfg = config(over);
  const ex = new PaperExchange(cfg.paper, [NAME]);
  const specs = await ex.init([NAME]);
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const log: Logger = (level, msg, extra) => logs.push({ level, msg, extra });
  const mm = new MarketMaker(cfg, ex, specs, { log, rng: () => 0.5, aptUsd: opts.apt === undefined ? undefined : () => opts.apt! });
  const run = async (fromSec: number, toSec: number) => {
    for (let t = fromSec; t < toSec; t += cfg.engine.tickMs / 1000) {
      ex.advance(T0 + t * 1000);
      await mm.step(T0 + t * 1000);
    }
  };
  return { cfg, ex, mm, logs, run, specs };
}

const view = (mm: MarketMaker, now: number) => (mm.snapshot(now).markets as Record<string, Record<string, number>>)[NAME]!;
const stat = (mm: MarketMaker, now: number) => mm.snapshot(now) as Record<string, any>;

describe("quoter helpers", () => {
  const p: QuoteParams = {
    levels: 2, baseHalfSpreadBps: 2, levelStepBps: 1, levelSizeUsd: 10, sizeGrowth: 1, inventorySkewBps: 0,
    maxPositionUsd: 100, minHalfSpreadBps: 0.6, spreadMult: 1, volBps: 0, volK: 0.5,
  };
  const spec: MarketSpec = { name: NAME, addr: "x", pxDecimals: 1, szDecimals: 4, tickSize: 0.1, lotSize: 0.0001, minSize: 0.0001 };
  const book = { bids: [{ price: 2699.9, size: 1 }], asks: [{ price: 2700, size: 1 }], ts: 0 };

  it("half spread follows the multiplier and keeps its floor", () => {
    expect(halfSpreadBps(p)).toBeCloseTo(2, 9);
    expect(halfSpreadBps({ ...p, spreadMult: 0.1 })).toBeCloseTo(0.6, 9);
    expect(halfSpreadBps({ ...p, volBps: 2, spreadMult: 2 })).toBeCloseTo(6, 9);
  });

  it("top level USD is the mean of the best bid and ask, or the one that exists", () => {
    const l: Ladder = { bids: [{ price: 100, size: 1 }], asks: [{ price: 100, size: 3 }] };
    expect(topLevelUsd(l)).toBe(200);
    expect(topLevelUsd({ bids: [], asks: [{ price: 50, size: 2 }] })).toBe(100);
    expect(topLevelUsd({ bids: [], asks: [] })).toBe(0);
  });

  it("guard ticks keep both touch quotes away from the opposite side", () => {
    const joined = buildLadder({ spec, fair: 2699.95, position: 0, book, params: { ...p, minHalfSpreadBps: 0, baseHalfSpreadBps: 0, competition: { joinTouch: true, improveTicks: 0, makerFeeBps: 0, maxCostBps: 5 } } });
    expect(joined.bids[0]!.price).toBeCloseTo(2699.9, 6); // sits right at the touch
    const guarded = buildLadder({ spec, fair: 2699.95, position: 0, book, params: { ...p, guardTicks: 2, minHalfSpreadBps: 0, baseHalfSpreadBps: 0, competition: { joinTouch: true, improveTicks: 0, makerFeeBps: 0, maxCostBps: 5 } } });
    expect(guarded.bids[0]!.price).toBeLessThanOrEqual(2700 - 3 * 0.1 + 1e-9);
    expect(guarded.asks[0]!.price).toBeGreaterThanOrEqual(2699.9 + 3 * 0.1 - 1e-9);
  });
});

describe("applyFillToLadder", () => {
  const spec = { tickSize: 0.1, lotSize: 0.0001, szDecimals: 4 } as MarketSpec;
  it("takes a partial fill off a level and drops a level that is used up", () => {
    const live: Ladder = { bids: [{ price: 100, size: 1 }, { price: 99.9, size: 2 }], asks: [{ price: 100.1, size: 1 }] };
    applyFillToLadder(live, { side: "buy", price: 100, size: 0.4 }, spec);
    expect(live.bids[0]).toEqual({ price: 100, size: 0.6 });
    applyFillToLadder(live, { side: "buy", price: 100, size: 0.6 }, spec);
    expect(live.bids.map((q) => q.price)).toEqual([99.9]);
    applyFillToLadder(live, { side: "sell", price: 100.1, size: 1 }, spec);
    expect(live.asks).toEqual([]);
  });
  it("ignores fills at prices it does not hold and a missing ladder", () => {
    const live: Ladder = { bids: [{ price: 100, size: 1 }], asks: [] };
    applyFillToLadder(live, { side: "buy", price: 95, size: 1 }, spec);
    expect(live.bids).toHaveLength(1);
    expect(() => applyFillToLadder(null, { side: "buy", price: 1, size: 1 }, spec)).not.toThrow();
  });
});

describe("gas in the cost controller", () => {
  it("gas lowers the measured pnl per volume and is tracked per day", () => {
    const pts = new PointsController({ costBudgetBps: 0.5, minSpreadMult: 0.6, maxSpreadMult: 4, dailyVolumeTargetUsd: 1e5, streakMinVolumeUsd: 1e4, markoutMs: 1000, ewmaHalfLifeUsd: 1000, minSampleUsd: 100, step: 1.05, controlIntervalMs: 1000 });
    const fill: Fill = { id: "1", market: NAME, side: "buy", price: 100, size: 10, feeUsd: 0, isMaker: true, ts: T0 };
    pts.onFill(fill, 100);
    pts.tick(T0 + 2000, () => 100);
    expect(pts.stats(T0 + 2000).ewmaPnlBps).toBeCloseTo(0, 6);
    pts.onGasCost(0.1, T0 + 2000); // 0.1 USD on 1000 USD of volume = 1 bp
    const s = pts.stats(T0 + 2000);
    expect(s.ewmaPnlBps).toBeCloseTo(-1, 6);
    expect(s.dayGasUsd).toBeCloseTo(0.1, 9);
    expect(pts.stats(T0 + 86_400_000 * 2).dayGasUsd).toBe(0);
  });

  it("the engine feeds the gas it paid into the controller once the APT price is known", async () => {
    const h = await build({}, { apt: 1 });
    await h.run(0, 60);
    const gas = stat(h.mm, T0 + 60_000).gasUsd as number;
    expect(gas).toBeGreaterThan(0);
    expect(gas).toBeCloseTo(h.ex.txCount * 0.0005 - 0, 3); // 1 USD per APT, every paper tx pays 0.0005 APT
  });

  it("without a price gas is not weighed", async () => {
    const h = await build({}, { apt: null });
    await h.run(0, 60);
    expect(stat(h.mm, T0 + 60_000).gasUsd).toBe(0);
    expect(stat(h.mm, T0 + 60_000).aptUsd).toBeNull();
  });
});

describe("economic reprice threshold", () => {
  it("gas cheap relative to the level: lower threshold; tiny level: higher; fixed when the rule is off or gas unpriced", async () => {
    const big = await build({ markets: [{ name: NAME, maxPositionUsd: 400, levelSizeUsd: 200, levels: 2, baseHalfSpreadBps: 2 }] }, { apt: 1 });
    await big.run(0, 10);
    const small = await build({ markets: [{ name: NAME, maxPositionUsd: 8, levelSizeUsd: 3, levels: 2, baseHalfSpreadBps: 2 }] }, { apt: 1 });
    await small.run(0, 10);
    const off = await build({ engine: { staleFillProb: 0, urgentRepriceBps: 7 } }, { apt: 1 });
    await off.run(0, 10);
    const unpriced = await build({ engine: { urgentRepriceBps: 7 } }, { apt: null });
    await unpriced.run(0, 10);
    const ub = view(big.mm, T0 + 10_000).urgentBps!;
    const us = view(small.mm, T0 + 10_000).urgentBps!;
    expect(ub).toBeLessThan(us);
    expect(ub).toBeGreaterThanOrEqual(2);
    expect(us).toBeLessThanOrEqual(10);
    expect(view(off.mm, T0 + 10_000).urgentBps).toBe(7);
    expect(view(unpriced.mm, T0 + 10_000).urgentBps).toBe(7);
  });
});

describe("replace reasons", () => {
  it("counts the first ladder as initial and later ones by what caused them", async () => {
    const h = await build({ engine: { minReplaceIntervalMs: 600_000 } }, { apt: 1 });
    await h.run(0, 3);
    let r = stat(h.mm, T0 + 3000).replaces as Record<string, number>;
    expect(r.initial).toBe(1);
    // a fill marks the ladder dirty, but with a long refresh interval nothing is re-sent for it
    const sim = (h.ex as unknown as { sims: Map<string, { ladder: Ladder; position: number }> }).sims.get(NAME)!;
    sim.position = 0.001;
    await h.run(3, 6);
    r = stat(h.mm, T0 + 6000).replaces as Record<string, number>;
    expect(Object.values(r).reduce((a, b) => a + b, 0)).toBe(h.ex.txCount);
  });
});

describe("a filled level is not price drift", () => {
  it("the top bid filling neither re-sends the ladder at once nor stays counted as our resting size", async () => {
    const h = await build({ engine: { minReplaceIntervalMs: 600_000, jitterPct: 0 }, markets: [{ name: NAME, maxPositionUsd: 400, levelSizeUsd: 100, levels: 3, baseHalfSpreadBps: 20, levelStepBps: 40, minHalfSpreadBps: 20 }] }, { apt: null });
    await h.run(0, 3);
    const sent = h.ex.txCount;
    const sim = (h.ex as unknown as { sims: Map<string, { ladder: Ladder }> }).sims.get(NAME)!;
    const top = sim.ladder.bids[0]!;
    const orig = h.ex.drainFills.bind(h.ex);
    let inject: Fill[] = [{ id: "m1", market: NAME, side: "buy", price: top.price, size: top.size, feeUsd: 0, isMaker: true, ts: T0 + 3100 }];
    h.ex.drainFills = () => [...orig(), ...inject.splice(0)];
    await h.run(3, 30);
    expect(h.ex.txCount).toBe(sent); // levels are 40 bps apart: judged against the ladder as sent, no drift
    const quotes = (h.mm.snapshot(T0 + 30_000).markets as Record<string, any>)[NAME].quotes.bids as number[][];
    expect(quotes).toHaveLength(2); // the filled level is gone from what we believe is resting
  });
});

describe("taker fills are told apart", () => {
  function takerFill(ts: number, n: number): Fill {
    return { id: `t${n}`, market: NAME, side: "buy", price: 2700, size: 0.01, feeUsd: 0.001, isMaker: false, ts };
  }

  it("a resting order that executed as taker is a crossing and widens the guard by itself", async () => {
    const h = await build({ competition: { crossesPerTick: 2, maxGuardTicks: 2 } }, { apt: 1 });
    await h.run(0, 2);
    expect(stat(h.mm, T0 + 2000).guardTicks).toBe(0);
    const orig = h.ex.drainFills.bind(h.ex);
    let inject: Fill[] = [];
    h.ex.drainFills = () => [...orig(), ...inject.splice(0)];
    inject = [takerFill(T0 + 2100, 1), takerFill(T0 + 2150, 2)];
    await h.run(2, 4);
    const s = stat(h.mm, T0 + 4000);
    expect(s.takerCross).toBe(2);
    expect(s.takerReduce).toBe(0);
    expect(s.guardTicks).toBe(1);
    inject = [takerFill(T0 + 4100, 3), takerFill(T0 + 4150, 4), takerFill(T0 + 4160, 5), takerFill(T0 + 4170, 6), takerFill(T0 + 4180, 7)];
    await h.run(4, 6);
    expect(stat(h.mm, T0 + 6000).guardTicks).toBe(2); // capped at maxGuardTicks
    await h.run(6, 7);
    expect(stat(h.mm, T0 + 3600_000 * 2).guardTicks).toBe(0); // the crossings are forgotten after an hour
    expect(h.logs.some((l) => l.msg.startsWith("taker fill") && l.extra?.kind === "cross")).toBe(true);
  });

  it("a taker fill right after our own reduce is a reduce", async () => {
    const h = await build({ markets: [{ name: NAME, maxPositionUsd: 40, levelSizeUsd: 20, levels: 2 }], rebate: { enabled: false } }, { apt: 1 });
    await h.run(0, 2);
    const sim = (h.ex as unknown as { sims: Map<string, { position: number }> }).sims.get(NAME)!;
    sim.position = 0.04; // ~108 USD long, far past the 60 USD emergency line
    await h.run(2, 4);
    const s = stat(h.mm, T0 + 4000);
    expect(s.takerReduce).toBeGreaterThan(0);
    expect(s.takerCross).toBe(0);
  });
});

describe("equity-scaled sizing", () => {
  it("cap follows equity x leverage with the configured numbers as ceilings", async () => {
    const h = await build({ sizing: { leverage: 2, levelFraction: 0.25, rebalanceTol: 0.1 }, markets: [{ name: NAME, maxPositionUsd: 500, levelSizeUsd: 100, levels: 2 }] }, { apt: 1 });
    await h.run(0, 3);
    const v = view(h.mm, T0 + 3000);
    expect(v.capUsd).toBeCloseTo(40, 6); // 20 USD x 2
    expect(v.levelUsd).toBeCloseTo(10, 6); // 25 % of the cap
  });

  it("the configured numbers stay a ceiling and the ramp stage still scales the result", async () => {
    const h = await build({ sizing: { leverage: 10, levelFraction: 0.5 }, ramp: { enabled: true, stages: [0.5, 1] }, markets: [{ name: NAME, maxPositionUsd: 60, levelSizeUsd: 12, levels: 2 }] }, { apt: 1 });
    await h.run(0, 3);
    const v = view(h.mm, T0 + 3000);
    expect(v.capUsd).toBeCloseTo(30, 6); // min(60, 200) x 0.5
    expect(v.levelUsd).toBeCloseTo(6, 6); // min(12, 60*0.5) x 0.5
  });

  it("is off by default and splits the budget over several markets", async () => {
    const fixed = await build({}, { apt: 1 });
    await fixed.run(0, 3);
    expect(view(fixed.mm, T0 + 3000).capUsd).toBe(100);

    const cfg = config({ sizing: { leverage: 3 }, markets: [{ name: "ETH/USD", maxPositionUsd: 500, levelSizeUsd: 100 }, { name: "BTC/USD", maxPositionUsd: 500, levelSizeUsd: 100 }] });
    const ex = new PaperExchange(cfg.paper, ["ETH/USD", "BTC/USD"]);
    const specs = await ex.init(["ETH/USD", "BTC/USD"]);
    const mm = new MarketMaker(cfg, ex, specs, { log: () => {} });
    ex.advance(T0);
    await mm.step(T0);
    ex.advance(T0 + 500);
    await mm.step(T0 + 500);
    const m = mm.snapshot(T0 + 500).markets as Record<string, Record<string, number>>;
    expect(m["ETH/USD"]!.capUsd).toBeCloseTo(30, 6); // 20 x 3 / 2
    expect(m["BTC/USD"]!.capUsd).toBeCloseTo(30, 6);
  });

  it("only re-derives the sizes when equity moved past the tolerance", async () => {
    const h = await build({ sizing: { leverage: 2, rebalanceTol: 0.2 }, markets: [{ name: NAME, maxPositionUsd: 500, levelSizeUsd: 100, levels: 2 }] }, { apt: 1 });
    await h.run(0, 2);
    const eq = { v: 20 };
    h.ex.getAccount = () => ({ equityUsd: eq.v, ts: 0 });
    await h.run(2, 3);
    eq.v = 18; // -10 %: inside the tolerance
    await h.run(3, 4);
    expect(view(h.mm, T0 + 4000).capUsd).toBeCloseTo(40, 6);
    eq.v = 14; // -30 %: outside
    await h.run(4, 5);
    expect(view(h.mm, T0 + 5000).capUsd).toBeCloseTo(28, 6);
  });
});

describe("gas economy", () => {
  it("stretches refresh intervals and thresholds while gas runs ahead of its budget, and stops at the budget", async () => {
    const h = await build({ risk: { maxGasAptPerDay: 0.1, minGasBalanceApt: 0 } }, { apt: 1 });
    let gasApt = 0;
    (h.ex as unknown as { getGas: () => unknown }).getGas = () => ({ txCount: 100, gasApt, balanceApt: 5 });
    await h.run(0, 3);
    expect(stat(h.mm, T0 + 3000).economy).toBe(1);
    gasApt = 0.04; // 40 % of the day's budget at 06:00 UTC (25 % of the day)
    await h.run(3, 5);
    expect(stat(h.mm, T0 + 5000).economy).toBeGreaterThan(1.5);
    gasApt = 0.15;
    await h.run(5, 7);
    expect(h.logs.some((l) => l.msg.startsWith("gas budget for the day spent"))).toBe(true);
  });

  it("gas spent earlier today by a previous process counts against the budget", async () => {
    const h = await build({ risk: { maxGasAptPerDay: 0.1, minGasBalanceApt: 0 } }, { apt: 1 });
    (h.mm as unknown as { gasCarryApt: number }).gasCarryApt = 0.2;
    (h.ex as unknown as { getGas: () => unknown }).getGas = () => ({ txCount: 0, gasApt: 0, balanceApt: 5 });
    await h.run(0, 3);
    expect(h.logs.some((l) => l.msg.startsWith("gas budget for the day spent"))).toBe(true);
  });
});
