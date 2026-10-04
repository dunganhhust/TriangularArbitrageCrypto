import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { MarketMaker } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";
import type { Ladder } from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1);

async function setup(over: Record<string, unknown>) {
  const cfg = configSchema.parse({
    markets: [{ name: "BTC/USD", maxPositionUsd: 500, levelSizeUsd: 100 }],
    ramp: { enabled: false },
    ...over,
  });
  const ex = new PaperExchange(cfg.paper, ["BTC/USD"]);
  const specs = await ex.init(["BTC/USD"]);
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const sent: Ladder[] = [];
  const orig = ex.replaceLadder.bind(ex);
  ex.replaceLadder = async (m, l) => {
    sent.push(JSON.parse(JSON.stringify(l)) as Ladder);
    return orig(m, l);
  };
  const mm = new MarketMaker(cfg, ex, specs, { log: (level, msg, extra) => logs.push({ level, msg, extra }), rng: () => 0.5 });
  const run = async (fromSec: number, toSec: number) => {
    for (let t = fromSec; t < toSec; t += cfg.engine.tickMs / 1000) {
      const now = T0 + t * 1000;
      ex.advance(now);
      await mm.step(now);
    }
  };
  return { cfg, ex, mm, logs, sent, run };
}

const ourBids = (ex: PaperExchange) => ex.getBook("BTC/USD")!.bids.length - 3; // 3 synthetic venue levels

describe("circuit breaker in the engine", () => {
  it("pulls every quote on a price shock, then quotes again after the cool-down", async () => {
    const h = await setup({ paper: { seed: 11, flowPerSec: 0.5, shockAtSec: 30, shockPct: -1 }, fuse: { cooldownMs: 40_000, recoverMs: 20_000 } });
    await h.run(0, 28);
    expect(ourBids(h.ex)).toBeGreaterThan(0);
    await h.run(28, 40);
    expect(h.logs.some((l) => l.msg === "FUSE tripped: pulling quotes")).toBe(true);
    expect(ourBids(h.ex)).toBe(0);
    expect(h.mm.isHalted).toBe(false);
    // The 40 s pause is over at 70 s; quotes come back then (a later, separate toxic-flow trip may pull them again).
    let quotedAgain = false;
    for (let t = 40; t < 120; t++) {
      await h.run(t, t + 1);
      if (t >= 70 && ourBids(h.ex) > 0) quotedAgain = true;
    }
    expect(quotedAgain).toBe(true);
  });

  it("does not trip the fuse a second time for the same shock while it is still paused", async () => {
    const h = await setup({ paper: { seed: 11, flowPerSec: 0.5, shockAtSec: 30, shockPct: -1 }, fuse: { cooldownMs: 40_000, recoverMs: 20_000 } });
    await h.run(0, 69);
    // the shock fills resolve their markouts during the pause: that is the same event, not a new trip
    expect(h.logs.filter((l) => l.msg === "FUSE tripped: pulling quotes")).toHaveLength(1);
  });

  it("quotes wider while recovering than in calm conditions", async () => {
    const h = await setup({ paper: { seed: 12, flowPerSec: 0.1, shockAtSec: 20, shockPct: 0.5 }, fuse: { cooldownMs: 10_000, recoverMs: 60_000, recoverWiden: 3 } });
    const width = (l: Ladder): number => l.asks[0]!.price - l.bids[0]!.price;
    const twoSided = (l: Ladder): boolean => l.bids.length > 0 && l.asks.length > 0;
    await h.run(0, 15);
    const calmWidth = width([...h.sent].reverse().find(twoSided)!);
    await h.run(15, 50); // shock at 20 s, pause, then recovery
    const pulled = h.sent.findIndex((l, i) => i > 0 && l.bids.length === 0 && l.asks.length === 0); // the cancel at the trip
    expect(pulled).toBeGreaterThan(0);
    const first = h.sent.slice(pulled).find(twoSided)!; // the first ladder after the pause
    expect(width(first)).toBeGreaterThan(calmWidth * 1.5);
  });

  it("halts the bot after too many trips in an hour", async () => {
    const h = await setup({ fuse: { haltAfterTripsPerHour: 2, cooldownMs: 1_000, recoverMs: 1_000 } });
    await h.run(0, 5);
    // Inject trips the way the toxic-flow path does.
    const fz = (h.mm as unknown as { states: Map<string, { fuse: { trip: (n: number, r: string) => unknown } }> }).states.get("BTC/USD")!.fuse;
    fz.trip(T0 + 5_000, "a");
    fz.trip(T0 + 6_000, "b");
    await h.run(6, 9);
    expect(h.mm.isHalted).toBe(true);
    expect(ourBids(h.ex)).toBe(0);
  });
});

describe("staged ramp in the engine", () => {
  it("starts at a fraction of the configured size", async () => {
    const full = await setup({ paper: { seed: 3, flowPerSec: 0.1 } });
    await full.run(0, 5);
    const ramped = await setup({ paper: { seed: 3, flowPerSec: 0.1 }, ramp: { enabled: true, stages: [0.25, 1] } });
    await ramped.run(0, 5);
    const a = full.sent[0]!.bids[0]!.size;
    const b = ramped.sent[0]!.bids[0]!.size;
    expect(b).toBeLessThan(a * 0.4);
    expect(b).toBeGreaterThan(0);
  });
});

describe("gas and staleness controls", () => {
  it("stops quoting for the day once the gas budget is spent", async () => {
    const h = await setup({ risk: { maxGasAptPerDay: 0.5, minGasBalanceApt: 0 } });
    let gasApt = 0;
    (h.ex as unknown as { getGas: () => unknown }).getGas = () => ({ txCount: 1, gasApt, balanceApt: 5 });
    await h.run(0, 5);
    expect(ourBids(h.ex)).toBeGreaterThan(0);
    gasApt = 0.6;
    await h.run(5, 7);
    expect(ourBids(h.ex)).toBe(0);
    const before = h.sent.length;
    await h.run(7, 20);
    expect(h.sent.length).toBe(before); // idle
    expect(h.logs.some((l) => l.msg.startsWith("gas budget for the day spent"))).toBe(true);
    expect(h.mm.isHalted).toBe(false);
  });

  it("re-quotes promptly after a modest move even with a long refresh interval", async () => {
    const h = await setup({
      engine: { minReplaceIntervalMs: 600_000, hardMinReplaceIntervalMs: 1_000, urgentRepriceBps: 6, jitterPct: 0 },
      markets: [{ name: "BTC/USD", maxPositionUsd: 500, levelSizeUsd: 100, baseHalfSpreadBps: 30, minHalfSpreadBps: 30 }],
      paper: { seed: 5, flowPerSec: 0.05, annualVolPct: 1, shockAtSec: 20, shockPct: 0.1 },
    });
    await h.run(0, 15);
    const before = h.sent.length;
    expect(before).toBe(1);
    await h.run(15, 40);
    expect(h.sent.length).toBeGreaterThan(before); // urgent drift beat the 10-minute schedule
    expect(h.logs.some((l) => l.msg === "FUSE tripped: pulling quotes")).toBe(false); // 10 bps is below the fuse
  });
});

describe("maker-rebate eligibility", () => {
  async function takerReduces(lowRatio: boolean): Promise<number> {
    const h = await setup({
      markets: [{ name: "BTC/USD", maxPositionUsd: 100, levelSizeUsd: 20 }],
      paper: { seed: 4, flowPerSec: 0.01, annualVolPct: 1 },
    });
    let reduces = 0;
    const orig = h.ex.reduce.bind(h.ex);
    h.ex.reduce = async (req) => {
      reduces++;
      return orig(req);
    };
    await h.run(0, 3);
    const sim = (h.ex as unknown as { sims: Map<string, { position: number }> }).sims.get("BTC/USD")!;
    sim.position = 200 / 60_000; // 200 USD long: past the 150 USD emergency line, short of the 300 USD extreme
    if (lowRatio) {
      const now = T0 + 3_000;
      h.mm.points.onFill({ id: "m", market: "BTC/USD", side: "buy", price: 60_000, size: 0.001, feeUsd: 0, isMaker: true, ts: now }, 60_000);
      h.mm.points.onFill({ id: "t", market: "BTC/USD", side: "sell", price: 60_000, size: 0.001, feeUsd: 0, isMaker: false, ts: now }, 60_000); // 50 % maker
    }
    await h.run(3, 4);
    return reduces;
  }

  it("uses a taker reduce when the maker ratio has room", async () => {
    expect(await takerReduces(false)).toBeGreaterThan(0);
  });

  it("holds the taker reduce while the cycle maker ratio is under the threshold", async () => {
    expect(await takerReduces(true)).toBe(0);
  });
});
