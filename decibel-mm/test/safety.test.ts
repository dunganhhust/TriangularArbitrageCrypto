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
    await h.run(40, 120);
    expect(ourBids(h.ex)).toBeGreaterThan(0); // back after the pause
  });

  it("quotes wider while recovering than in calm conditions", async () => {
    const h = await setup({ paper: { seed: 12, flowPerSec: 0.1, shockAtSec: 20, shockPct: 0.5 }, fuse: { cooldownMs: 10_000, recoverMs: 60_000, recoverWiden: 3 } });
    const lastQuoted = (): Ladder => [...h.sent].reverse().find((l) => l.bids.length > 0 && l.asks.length > 0)!;
    const width = (l: Ladder): number => l.asks[0]!.price - l.bids[0]!.price;
    await h.run(0, 15);
    const calmWidth = width(lastQuoted());
    await h.run(15, 50); // shock at 20s, pause, then recovery
    expect(width(lastQuoted())).toBeGreaterThan(calmWidth * 1.5);
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
