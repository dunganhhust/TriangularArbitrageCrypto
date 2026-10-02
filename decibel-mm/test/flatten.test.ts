import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { MarketMaker } from "../src/engine.js";
import type { Logger } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";
import type { ReduceRequest } from "../src/exchange/exchange.js";
import { runLoop } from "../src/runner.js";

const NAMES = ["BTC/USD", "ETH/USD"];
const noSleep = async (): Promise<void> => {};
const MIN_SIZE = 0.0001; // the paper venue's minimum order size

function config(over: Record<string, unknown> = {}) {
  return configSchema.parse({
    markets: NAMES.map((n) => ({ name: n, maxPositionUsd: 500, levelSizeUsd: 100 })),
    paper: { seed: 21, flowPerSec: 5 },
    ...over,
  });
}

/** A paper venue whose positions and fills the test controls. */
class Stub extends PaperExchange {
  pos: Record<string, number> = {};
  reduceCalls: ReduceRequest[] = [];
  /** When false, reduce-only orders are accepted but never fill (a venue that ignores them). */
  fillMode = true;
  override getPosition(m: string): number {
    return this.pos[m] ?? 0;
  }
  override async reduce(req: ReduceRequest): Promise<boolean> {
    this.reduceCalls.push(req);
    if (this.fillMode) {
      const p = this.pos[req.market] ?? 0;
      this.pos[req.market] = req.side === "sell" ? Math.max(0, p - req.size) : Math.min(0, p + req.size);
    }
    return true;
  }
}

async function stubbed(pos: Record<string, number>, fills = true) {
  const cfg = config();
  const ex = new Stub(cfg.paper, NAMES);
  const specs = await ex.init(NAMES);
  ex.advance(Date.UTC(2026, 0, 1));
  ex.advance(Date.UTC(2026, 0, 1) + 250);
  ex.pos = pos;
  ex.fillMode = fills;
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const log: Logger = (level, msg, extra) => logs.push({ level, msg, extra });
  const mm = new MarketMaker(cfg, ex, specs, { log, sleep: noSleep });
  return { cfg, ex, mm, logs };
}

describe("flattenAll", () => {
  it("closes a long and a short with reduce-only orders on the right side of the book", async () => {
    const { ex, mm } = await stubbed({ "BTC/USD": 0.0123, "ETH/USD": -0.5 });
    const res = await mm.flattenAll();
    expect(res).toMatchObject({ closed: true, residual: {}, orders: 2 });
    expect(ex.getPosition("BTC/USD")).toBe(0);
    expect(ex.getPosition("ETH/USD")).toBe(0);
    const btc = ex.reduceCalls.find((c) => c.market === "BTC/USD")!;
    const eth = ex.reduceCalls.find((c) => c.market === "ETH/USD")!;
    expect(btc.side).toBe("sell"); // closing a long
    expect(eth.side).toBe("buy"); // closing a short
    expect(btc.size).toBeCloseTo(0.0123, 8);
    const bid = ex.getBook("BTC/USD")!.bids[0]!.price;
    const ask = ex.getBook("ETH/USD")!.asks[0]!.price;
    expect(btc.limitPrice).toBeLessThan(bid); // sells below the bid so the IOC crosses
    expect(eth.limitPrice).toBeGreaterThan(ask); // buys above the ask
  });

  it("stops quoting: the engine is halted and no new ladder is placed afterwards", async () => {
    const { ex, mm } = await stubbed({});
    await mm.step(Date.UTC(2026, 0, 1) + 500);
    const tx = ex.txCount;
    await mm.flattenAll();
    expect(mm.isHalted).toBe(true);
    await mm.step(Date.UTC(2026, 0, 1) + 60_000);
    expect(ex.txCount).toBe(tx + NAMES.length); // only the cancels from flattenAll, nothing from step()
  });

  it("widens the limit on every retry and gives up honestly when the venue never fills", async () => {
    const { ex, mm, logs } = await stubbed({ "ETH/USD": 0.02 }, false);
    const res = await mm.flattenAll();
    expect(res.closed).toBe(false);
    expect(res.residual).toEqual({ "ETH/USD": 0.02 });
    expect(res.orders).toBe(5);
    const limits = ex.reduceCalls.map((c) => c.limitPrice);
    for (let i = 1; i < limits.length; i++) expect(limits[i]!).toBeLessThan(limits[i - 1]!); // sells go ever lower
    expect(logs.at(-1)).toMatchObject({ level: "error", msg: "flatten: INCOMPLETE, positions remain" });
  });

  it("does not try to trade a position below the market minimum, and reports it as dust", async () => {
    const { ex, mm } = await stubbed({ "BTC/USD": 0.00004 });
    const res = await mm.flattenAll();
    expect(ex.reduceCalls).toHaveLength(0);
    expect(res).toMatchObject({ closed: true, orders: 0, dust: { "BTC/USD": 0.00004 } });
  });

  it("reports an error instead of guessing when there is no price at all", async () => {
    const { ex, mm, logs } = await stubbed({ "ETH/USD": 0.01 });
    ex.getBook = () => null;
    ex.getPrice = () => null;
    const res = await mm.flattenAll();
    expect(res.closed).toBe(false);
    expect(ex.reduceCalls).toHaveLength(0);
    expect(logs.some((l) => l.msg === "flatten: no price for market, cannot close")).toBe(true);
  });

  it("a single dry attempt sends at most one order per market", async () => {
    const { ex, mm } = await stubbed({ "ETH/USD": 0.02 }, false);
    const res = await mm.flattenAll({ attempts: 1 });
    expect(res.orders).toBe(1);
    expect(ex.reduceCalls).toHaveLength(1);
  });
});

describe("runLoop", () => {
  async function simulated(over: Record<string, unknown> = {}) {
    const cfg = config(over);
    const ex = new PaperExchange(cfg.paper, NAMES);
    const specs = await ex.init(NAMES);
    const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
    const log: Logger = (level, msg, extra) => logs.push({ level, msg, extra });
    const t0 = Date.UTC(2026, 0, 1);
    let t = t0;
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
    const mm = new MarketMaker(cfg, ex, specs, { log, sleep: noSleep, killSwitch: () => killed });
    let killed = false;
    return { cfg, ex, mm, logs, t0, clock, kill: () => (killed = true), time: () => t };
  }

  it("at the deadline it pulls quotes, closes every position and says so", async () => {
    const s = await simulated();
    let ending = 0;
    const res = await runLoop({
      mm: s.mm,
      tickMs: s.cfg.engine.tickMs,
      endsAt: s.t0 + 10 * 60_000,
      stopFile: "never",
      log: (l, m, e) => s.logs.push({ level: l, msg: m, extra: e }),
      onEnding: () => ending++,
      exists: () => false,
      beforeStep: (now) => s.ex.advance(now),
      ...s.clock,
    });
    expect(res.end).toBe("deadline");
    expect(res.flat?.closed).toBe(true);
    expect(ending).toBe(1);
    expect(s.time()).toBeGreaterThanOrEqual(s.t0 + 10 * 60_000);
    expect(s.time()).toBeLessThan(s.t0 + 10 * 60_000 + 2_000);
    for (const n of NAMES) expect(Math.abs(s.ex.getPosition(n))).toBeLessThan(MIN_SIZE); // only dust below the minimum order may remain
    const msgs = s.logs.map((l) => l.msg);
    expect(msgs.indexOf("run ending: pulling quotes and closing every position")).toBeGreaterThan(-1);
    expect(msgs.indexOf("run finished")).toBeGreaterThan(msgs.indexOf("run ending: pulling quotes and closing every position"));
    expect(s.logs.find((l) => l.msg === "run finished")!.extra).toMatchObject({ reason: "deadline", flat: true });
  });

  it("really had positions to close in that run (the test is not vacuous)", async () => {
    const s = await simulated({ paper: { seed: 21, flowPerSec: 8 } });
    let before = 0;
    await runLoop({
      mm: s.mm,
      tickMs: s.cfg.engine.tickMs,
      endsAt: s.t0 + 5 * 60_000,
      stopFile: "never",
      log: () => {},
      exists: () => false,
      beforeStep: (now) => {
        s.ex.advance(now);
        before = Math.max(before, ...NAMES.map((n) => Math.abs(s.ex.getPosition(n)) * 60_000));
      },
      ...s.clock,
    });
    expect(before).toBeGreaterThan(1); // held more than 1 USD at some point before the end
    for (const n of NAMES) expect(Math.abs(s.ex.getPosition(n))).toBeLessThan(MIN_SIZE); // only dust below the minimum order may remain
  });

  it("the STOP file ends the run the same way and is removed afterwards", async () => {
    const s = await simulated();
    const removed: string[] = [];
    const res = await runLoop({
      mm: s.mm,
      tickMs: s.cfg.engine.tickMs,
      endsAt: null,
      stopFile: "state/STOP",
      log: (l, m, e) => s.logs.push({ level: l, msg: m, extra: e }),
      exists: (p) => p === "state/STOP" && s.time() >= s.t0 + 30_000,
      remove: (p) => removed.push(p),
      beforeStep: (now) => s.ex.advance(now),
      ...s.clock,
    });
    expect(res.end).toBe("stop");
    expect(res.flat?.closed).toBe(true);
    expect(removed).toEqual(["state/STOP"]);
    expect(s.logs.find((l) => l.msg === "run finished")!.extra).toMatchObject({ reason: "stop" });
  });

  it("a halt keeps its old meaning: quotes pulled, positions left alone, no close-out", async () => {
    const s = await simulated();
    let steps = 0;
    const res = await runLoop({
      mm: s.mm,
      tickMs: s.cfg.engine.tickMs,
      endsAt: null,
      stopFile: "never",
      log: (l, m, e) => s.logs.push({ level: l, msg: m, extra: e }),
      exists: () => false,
      beforeStep: (now) => {
        s.ex.advance(now);
        if (++steps === 40) s.kill();
      },
      ...s.clock,
    });
    expect(res).toEqual({ end: "halted", flat: null });
    expect(s.logs.some((l) => l.msg.startsWith("run ending"))).toBe(false);
  });

  it("reports an unclosed position as an error and still ends", async () => {
    const cfg = config();
    const ex = new Stub(cfg.paper, NAMES);
    const specs = await ex.init(NAMES);
    ex.pos = { "ETH/USD": 0.05 };
    ex.fillMode = false;
    const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
    const log: Logger = (level, msg, extra) => logs.push({ level, msg, extra });
    const mm = new MarketMaker(cfg, ex, specs, { log, sleep: noSleep });
    const t0 = Date.UTC(2026, 0, 1);
    let t = t0;
    const res = await runLoop({
      mm,
      tickMs: 250,
      endsAt: t0 + 1_000,
      stopFile: "never",
      log,
      exists: () => false,
      beforeStep: (now) => ex.advance(now),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(res.end).toBe("deadline");
    expect(res.flat).toMatchObject({ closed: false, residual: { "ETH/USD": 0.05 } });
    expect(logs.find((l) => l.msg === "run finished")).toMatchObject({ level: "error", extra: { flat: false } });
  });
});
