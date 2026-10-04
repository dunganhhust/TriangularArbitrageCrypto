import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { MarketMaker } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";

function setup(over: Record<string, unknown> = {}, kill = () => false) {
  const cfg = configSchema.parse({
    markets: [{ name: "BTC-USD", maxPositionUsd: 500, levelSizeUsd: 100 }],
    paper: { seed: 7 },
    ...over,
  });
  const ex = new PaperExchange(cfg.paper, ["BTC-USD"]);
  return { cfg, ex, kill };
}

async function run(over: Record<string, unknown>, steps: number, kill = () => false) {
  const { cfg, ex } = setup(over);
  const specs = await ex.init(["BTC-USD"]);
  const logs: string[] = [];
  const mm = new MarketMaker(cfg, ex, specs, { log: (_l, m) => logs.push(m), killSwitch: kill });
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < steps && !mm.isHalted; i++) {
    const now = t0 + i * cfg.engine.tickMs;
    ex.advance(now);
    await mm.step(now);
  }
  return { cfg, ex, mm, logs };
}

describe("MarketMaker + paper venue", () => {
  it("places a two-sided ladder and keeps tx volume bounded", async () => {
    const { ex } = await run({}, 400);
    const book = ex.getBook("BTC-USD")!;
    expect(book.bids.length).toBeGreaterThan(3); // venue levels + ours
    expect(ex.txCount).toBeGreaterThan(0);
    expect(ex.txCount).toBeLessThan(400); // throttled below one tx per tick
  });

  it("fills as a maker and respects the position limit", async () => {
    const { ex } = await run({ paper: { seed: 3, flowPerSec: 6 } }, 4000);
    const pos = ex.getPosition("BTC-USD") * 60_000;
    expect(Math.abs(pos)).toBeLessThan(500 * 1.5 + 50);
  });

  it("halts and pulls quotes on the kill switch", async () => {
    let kill = false;
    const { cfg, ex } = setup();
    const specs = await ex.init(["BTC-USD"]);
    const mm = new MarketMaker(cfg, ex, specs, { log: () => {}, killSwitch: () => kill });
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 20; i++) {
      ex.advance(t0 + i * 250);
      await mm.step(t0 + i * 250);
    }
    expect(ex.getBook("BTC-USD")!.bids.length).toBeGreaterThan(3);
    kill = true;
    await mm.step(t0 + 21 * 250);
    expect(mm.isHalted).toBe(true);
    expect(ex.getBook("BTC-USD")!.bids).toHaveLength(3); // only the synthetic venue levels remain
  });

  it("halts on drawdown beyond the limit", async () => {
    const { cfg, ex } = setup({ risk: { maxDrawdownUsd: 0.01 }, paper: { seed: 5, flowPerSec: 10, annualVolPct: 300 } });
    const specs = await ex.init(["BTC-USD"]);
    const mm = new MarketMaker(cfg, ex, specs, { log: () => {} });
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 20_000 && !mm.isHalted; i++) {
      ex.advance(t0 + i * 250);
      await mm.step(t0 + i * 250);
    }
    expect(mm.isHalted).toBe(true);
  });
});

describe("gas guards", () => {
  it("halts and cancels while gas remains when the signer balance drops below the reserve", async () => {
    const { cfg, ex } = setup({ risk: { minGasBalanceApt: 0.05 } });
    let balance = 1;
    (ex as unknown as { getGas: () => unknown }).getGas = () => ({ txCount: 0, gasApt: 0, balanceApt: balance });
    const specs = await ex.init(["BTC-USD"]);
    const mm = new MarketMaker(cfg, ex, specs, { log: () => {} });
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 20; i++) {
      ex.advance(t0 + i * 250);
      await mm.step(t0 + i * 250);
    }
    expect(mm.isHalted).toBe(false);
    expect(ex.getBook("BTC-USD")!.bids.length).toBeGreaterThan(3);
    balance = 0.01;
    ex.advance(t0 + 21 * 250);
    await mm.step(t0 + 21 * 250);
    expect(mm.isHalted).toBe(true);
    expect(ex.getBook("BTC-USD")!.bids).toHaveLength(3); // our quotes were pulled
  });

  it("caps transaction rate at the hard minimum interval", async () => {
    const { ex } = await run({ engine: { tickMs: 100, minReplaceIntervalMs: 100, hardMinReplaceIntervalMs: 2000 }, paper: { seed: 9, flowPerSec: 6 } }, 600);
    // 600 ticks * 100ms = 60s of simulated time; at most one tx per 2s per market (+ the first).
    expect(ex.txCount).toBeLessThanOrEqual(31);
  });
});
