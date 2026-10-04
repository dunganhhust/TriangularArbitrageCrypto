import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { MarketMaker } from "../src/engine.js";
import type { Logger } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";
import type { ReduceRequest } from "../src/exchange/exchange.js";
import { runLoop, Shutdown } from "../src/runner.js";
import { VolatilityFuse } from "../src/strategy/fuse.js";
import type { Fill, Ladder } from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1, 6);
const NAME = "ETH/USD";
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class Stub extends PaperExchange {
  equity: number | null = 20;
  pos = 0;
  cancelOk = true;
  cancelCalls = 0;
  override getPosition(): number {
    return this.pos;
  }
  override getAccount(): ReturnType<PaperExchange["getAccount"]> {
    return (this.equity === null ? null : { equityUsd: this.equity, ts: 0 }) as ReturnType<PaperExchange["getAccount"]>;
  }
  override async cancelAll(m: string): Promise<boolean> {
    this.cancelCalls++;
    if (!this.cancelOk) return false;
    return super.cancelAll(m);
  }
  override async reduce(req: ReduceRequest): Promise<boolean> {
    this.pos = req.side === "sell" ? Math.max(0, this.pos - req.size) : Math.min(0, this.pos + req.size);
    return true;
  }
}

async function build(over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const cfg = configSchema.parse({
    markets: [{ name: NAME, maxPositionUsd: 100, levelSizeUsd: 30, levels: 2 }],
    ramp: { enabled: false },
    paper: { startMid: 2700, annualVolPct: 5, flowPerSec: 0.001, equityUsd: 20, seed: 11 },
    ...over,
  });
  const ex = new Stub(cfg.paper, [NAME]);
  const specs = await ex.init([NAME]);
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const log: Logger = (level, msg, extra) => logs.push({ level, msg, extra });
  const mm = new MarketMaker(cfg, ex, specs, { log, rng: () => 0.5, sleep: async () => {}, ...opts });
  const run = async (fromSec: number, toSec: number) => {
    for (let t = fromSec; t < toSec; t += cfg.engine.tickMs / 1000) {
      ex.advance(T0 + t * 1000);
      await mm.step(T0 + t * 1000);
    }
  };
  const ourBids = () => ex.getBook(NAME)!.bids.length - 3;
  return { cfg, ex, mm, logs, run, ourBids };
}
const snap = (mm: MarketMaker, t: number) => mm.snapshot(t) as Record<string, any>;
const view = (mm: MarketMaker, t: number) => (snap(mm, t).markets as Record<string, Record<string, any>>)[NAME]!;

describe("a bad equity reading is not believed on its own", () => {
  const limits = { risk: { maxDrawdownUsd: 4, minEquityUsd: 14, maxDailyLossUsd: 1.2 }, sizing: { leverage: 1.5 } };

  it("one reading of zero neither trips the drawdown stop nor the floor, the daily pause or the sizing", async () => {
    const h = await build(limits);
    await h.run(0, 5);
    const cap = view(h.mm, T0 + 5000).capUsd;
    expect(cap).toBeCloseTo(30, 6);
    h.ex.equity = 0;
    await h.run(5, 5.5);
    h.ex.equity = 20;
    await h.run(5.5, 40);
    expect(h.mm.isHalted).toBe(false);
    expect(snap(h.mm, T0 + 40_000).phase).toBe("running");
    expect(view(h.mm, T0 + 40_000).capUsd).toBeCloseTo(cap, 6);
    expect(h.ourBids()).toBeGreaterThan(0);
  });

  it("a wild drop (-75 %) that lasts one reading is ignored too; the same value held for 12 s is believed", async () => {
    const h = await build(limits);
    await h.run(0, 5);
    h.ex.equity = 5;
    await h.run(5, 6);
    h.ex.equity = 20;
    await h.run(6, 30);
    expect(h.mm.isHalted).toBe(false);
    h.ex.equity = 5; // and now it stays that way
    await h.run(30, 80);
    expect(h.mm.isHalted).toBe(true); // drawdown / floor, after the value has persisted
  });

  it("with no equity reading at all and equity-based sizing it quotes nothing instead of the configured maximum", async () => {
    const h = await build({ sizing: { leverage: 1.5 } });
    h.ex.equity = null;
    await h.run(0, 10);
    expect(h.ourBids()).toBe(0);
    h.ex.equity = 20;
    await h.run(10, 20);
    expect(h.ourBids()).toBeGreaterThan(0);
  });
});

describe("a cancel the venue did not accept is retried", () => {
  it("while blind: the quotes are still believed resting until a cancel goes through, and it keeps trying", async () => {
    const h = await build();
    const age = { positionsMs: 100 as number | null, accountMs: 100 as number | null };
    (h.ex as unknown as { dataAge: () => typeof age }).dataAge = () => age;
    await h.run(0, 3);
    expect(h.ourBids()).toBeGreaterThan(0);
    h.ex.cancelOk = false;
    age.positionsMs = 120_000;
    await h.run(3, 30);
    expect(h.ex.cancelCalls).toBeGreaterThan(4); // the first three attempts plus the 5 s retries
    expect(view(h.mm, T0 + 30_000).quoting).toBe(true); // it does not pretend the quotes are gone
    h.ex.cancelOk = true;
    await h.run(30, 40);
    expect(h.ourBids()).toBe(0);
    expect(view(h.mm, T0 + 40_000).quoting).toBe(false);
  });

  it("a halt tries five times before giving up", async () => {
    const h = await build();
    await h.run(0, 3);
    h.ex.cancelOk = false;
    const before = h.ex.cancelCalls;
    await h.mm.haltAll();
    expect(h.ex.cancelCalls - before).toBe(5);
  });

  it("start-up cleanup reports a failed cancel as an error", async () => {
    const h = await build();
    (h.ex as unknown as { listResting: () => Promise<string[]> }).listResting = async () => [NAME];
    h.ex.cancelOk = false;
    await h.mm.cleanupLeftovers();
    expect(h.logs.some((l) => l.level === "error" && l.msg.includes("could not cancel quotes left behind"))).toBe(true);
  });
});

describe("the kill switch works in every state", () => {
  it("halts even while the daily loss pause is in force", async () => {
    let kill = false;
    const h = await build({ risk: { maxDailyLossUsd: 1 } }, { killSwitch: () => kill });
    await h.run(0, 3);
    h.ex.equity = 18;
    await h.run(3, 30);
    expect(snap(h.mm, T0 + 30_000).phase).toBe("paused");
    kill = true;
    await h.run(30, 31);
    expect(h.mm.isHalted).toBe(true);
  });
});

describe("daily loss pause close-out retries widen the limit", () => {
  it("each retry uses a wider limit than the one before", async () => {
    const h = await build({ risk: { maxDailyLossUsd: 1 } });
    await h.run(0, 3);
    const limits: number[] = [];
    h.ex.reduce = async (req: ReduceRequest) => {
      limits.push(req.limitPrice); // never fills
      return true;
    };
    h.ex.pos = 0.01;
    h.ex.equity = 18;
    await h.run(3, 200);
    expect(limits.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < 4; i++) expect(limits[i]!).toBeLessThan(limits[i - 1]!); // selling: each limit lower than the last
  });
});

describe("the watchdog does not mistake a fuse pause for an outage", () => {
  it("a stale-book pause followed by a long fuse pause never asks for a restart", async () => {
    const h = await build({ engine: { watchdogMs: 20_000 }, fuse: { cooldownMs: 600_000 } });
    await h.run(0, 3);
    // the book goes stale for a few seconds: the market is "paused: stale book"
    const realBook = h.ex.getBook.bind(h.ex);
    let stale = true;
    h.ex.getBook = (m: string) => {
      const b = realBook(m);
      return b && stale ? { ...b, ts: 0 } : b;
    };
    await h.run(3, 6);
    expect(view(h.mm, T0 + 6000).paused).toBe("stale book");
    stale = false;
    const fuse = (h.mm as unknown as { states: Map<string, { fuse: VolatilityFuse }> }).states.get(NAME)!.fuse;
    fuse.trip(T0 + 6000, "test");
    await h.run(6, 200);
    expect(h.mm.restartRequested(T0 + 200_000)).toBe(false);
  });
});

describe("replace reasons are told apart", () => {
  it("a fill, a price shock and a size change are counted under their own reasons", async () => {
    const fill = await build({ engine: { minReplaceIntervalMs: 20_000, jitterPct: 0, urgentRepriceBps: 50 }, markets: [{ name: NAME, maxPositionUsd: 400, levelSizeUsd: 100, levels: 3, baseHalfSpreadBps: 20, levelStepBps: 40, minHalfSpreadBps: 20 }] });
    await fill.run(0, 3);
    const sim = (fill.ex as unknown as { sims: Map<string, { ladder: Ladder }> }).sims.get(NAME)!;
    const top = sim.ladder.bids[0]!;
    const orig = fill.ex.drainFills.bind(fill.ex);
    let inject: Fill[] = [{ id: "m1", market: NAME, side: "buy", price: top.price, size: top.size, feeUsd: 0, isMaker: true, ts: T0 + 3100 }];
    fill.ex.drainFills = () => [...orig(), ...inject.splice(0)];
    await fill.run(3, 40);
    const r = snap(fill.mm, T0 + 40_000).replaces as Record<string, number>;
    expect(r.initial).toBe(1);
    expect(r.fill).toBe(1); // the fill marked the ladder dirty and the refresh came at the next due time, not before
    expect((r.drift ?? 0) + (r.threat ?? 0) + (r.stale ?? 0)).toBe(0);

    const shock = await build({ paper: { startMid: 2700, annualVolPct: 1, flowPerSec: 0.001, equityUsd: 20, seed: 5, shockAtSec: 10, shockPct: 0.1 }, engine: { minReplaceIntervalMs: 600_000, urgentRepriceBps: 6, staleFillProb: 0 }, markets: [{ name: NAME, maxPositionUsd: 400, levelSizeUsd: 100, levels: 2, baseHalfSpreadBps: 30, minHalfSpreadBps: 30 }] });
    await shock.run(0, 30);
    const s = snap(shock.mm, T0 + 30_000).replaces as Record<string, number>;
    expect((s.drift ?? 0) + (s.threat ?? 0)).toBeGreaterThanOrEqual(1); // the market ran into the ladder
    expect((s.fill ?? 0) + (s.stale ?? 0)).toBe(0);

    const size = await build({ sizing: { leverage: 2 }, engine: { minReplaceIntervalMs: 5_000, jitterPct: 0 }, markets: [{ name: NAME, maxPositionUsd: 400, levelSizeUsd: 100, levels: 2 }] });
    await size.run(0, 3);
    size.ex.equity = 13; // -35 %: believed at once, the ladder is now too big for the new cap
    await size.run(3, 30);
    const z = snap(size.mm, T0 + 30_000).replaces as Record<string, number>;
    expect(z.stale ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("Shutdown.onFatal", () => {
  function setup(opts: { haltAll?: () => Promise<void> } = {}) {
    const events: string[] = [];
    const sd = new Shutdown({
      haltAll: opts.haltAll ?? (async () => void events.push("haltAll")),
      close: async () => void events.push("close"),
      exit: (c) => events.push(`exit:${c}`),
      log: (_l, m) => events.push(`log:${m}`),
      fatalTimeoutMs: 50,
    });
    return { sd, events };
  }

  it("pulls the quotes, then exits 70 (restart me), and shows as pending at once", async () => {
    const { sd, events } = setup();
    sd.onFatal("uncaught exception", new Error("boom"));
    expect(sd.pending()).not.toBeNull();
    await sd.pending();
    expect(events.filter((e) => !e.startsWith("log:"))).toEqual(["haltAll", "exit:70"]);
  });

  it("the control loop that sees the halt waits for it instead of exiting with 2 over the cancels", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sd, events } = setup({ haltAll: async () => { events.push("haltAll:start"); await gate; events.push("haltAll:done"); } });
    sd.onFatal("unhandled rejection", "x");
    const loop = (async () => {
      const cancelling = sd.pending(); // what runLive does when runLoop returns {end:"halted"}
      if (cancelling) await cancelling;
      else events.push("exit:2");
    })();
    await new Promise((r) => setTimeout(r, 10));
    expect(events).not.toContain("exit:2");
    release();
    await loop;
    expect(events.filter((e) => e.startsWith("exit"))).toEqual(["exit:70"]);
    expect(events.indexOf("haltAll:done")).toBeLessThan(events.indexOf("exit:70"));
  });

  it("exits anyway when the cancels hang", async () => {
    const { sd, events } = setup({ haltAll: () => new Promise(() => {}) });
    sd.onFatal("uncaught exception", "x");
    await sd.pending();
    expect(events).toContain("exit:70");
  });

  it("is only acted on once, and not at all while a signal shutdown is already under way", async () => {
    const a = setup();
    a.sd.onFatal("e", "1");
    a.sd.onFatal("e", "2");
    await a.sd.pending();
    expect(a.events.filter((e) => e === "haltAll")).toHaveLength(1);
    const b = setup();
    void b.sd.onSignal("SIGTERM");
    b.sd.onFatal("e", "x");
    await b.sd.pending();
    expect(b.events.filter((e) => e.startsWith("exit"))).toEqual(["exit:0"]);
  });

  it("while positions are being closed it only logs: exiting would abandon the close-out", () => {
    const { sd, events } = setup();
    sd.markEnding();
    sd.onFatal("uncaught exception", new Error("late"));
    expect(sd.pending()).toBeNull();
    expect(events.some((e) => e.startsWith("exit"))).toBe(false);
    expect(events.some((e) => e.includes("while closing positions"))).toBe(true);
  });
});

describe("runLoop watchdog on failing steps", () => {
  it("asks for a restart, with the quotes pulled, when every step throws", async () => {
    const h = await build();
    const logs: string[] = [];
    let t = T0;
    h.mm.step = async () => {
      throw new Error("reduce rejected");
    };
    let halted = 0;
    const real = h.mm.haltAll.bind(h.mm);
    h.mm.haltAll = async () => {
      halted++;
      return real();
    };
    const res = await runLoop({ mm: h.mm, tickMs: 250, endsAt: null, stopFile: "never", log: (_l, m) => logs.push(m), exists: () => false, now: () => t, sleep: async (ms) => void (t += ms), maxStepFailures: 8 });
    expect(res).toEqual({ end: "restart", flat: null });
    expect(halted).toBe(1);
    expect(logs.filter((m) => m === "step failed").length).toBeLessThan(8); // not a line per tick
    expect(logs).toContain("watchdog: every step is failing; pulling quotes and asking for a restart");
  });

  it("a step that fails now and then does not trigger it", async () => {
    const h = await build();
    let n = 0;
    const real = h.mm.step.bind(h.mm);
    h.mm.step = async (now: number) => {
      if (++n % 3 === 0) throw new Error("blip");
      return real(now);
    };
    let t = T0;
    const res = await runLoop({ mm: h.mm, tickMs: 250, endsAt: T0 + 20_000, stopFile: "never", log: () => {}, exists: () => false, beforeStep: (now) => h.ex.advance(now), now: () => t, sleep: async (ms) => void (t += ms), maxStepFailures: 5 });
    expect(res.end).toBe("deadline");
  });
});

describe("a fuse trip never shortens a pause already running", () => {
  const cfg = { enabled: true, fastMoveBps: 15, fastWindowMs: 5000, slowMoveBps: 40, slowWindowMs: 60_000, spreadBps: 10, oracleDevBps: 15, cooldownMs: 60_000, maxCooldownMs: 1_800_000, recoverMs: 300_000, recoverWiden: 2, haltAfterTripsPerHour: 3, toxicFills: 5, toxicMarkoutBps: 3, haltMode: "cooloff" as const, cooloffMs: 3_600_000 };
  it("a later, ordinary trip during a cool-off leaves it at an hour", () => {
    const f = new VolatilityFuse(cfg);
    f.trip(0, "a");
    f.trip(1000, "b");
    f.trip(2000, "c"); // cool-off: until = 2000 + 1 h, history cleared
    expect(f.untilMs).toBe(2000 + 3_600_000);
    f.trip(12_000, "toxic flow"); // an ordinary 60 s trip ten seconds later
    expect(f.untilMs).toBe(2000 + 3_600_000);
  });
  it("a trip that asks for a longer pause still lengthens it", () => {
    const f = new VolatilityFuse(cfg);
    f.trip(0, "a");
    expect(f.untilMs).toBe(60_000);
    f.trip(10_000, "b"); // second trip within the hour: 120 s from now
    expect(f.untilMs).toBe(130_000);
  });
});
