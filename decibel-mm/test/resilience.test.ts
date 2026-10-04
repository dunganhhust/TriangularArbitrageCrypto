import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";
import { MarketMaker, jsonLogger, setRunLogFile } from "../src/engine.js";
import type { Logger } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";
import { runLoop } from "../src/runner.js";
import { VolatilityFuse } from "../src/strategy/fuse.js";
import type { ReduceRequest } from "../src/exchange/exchange.js";

const T0 = Date.UTC(2026, 0, 1, 6);
const NAME = "ETH/USD";
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setRunLogFile(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mm-res-"));
  dirs.push(d);
  return d;
};

/** Paper venue whose positions, equity and data freshness the test controls. */
class Stub extends PaperExchange {
  pos = 0;
  equity = 20;
  age: { positionsMs: number | null; accountMs: number | null } = { positionsMs: 100, accountMs: 100 };
  resting: string[] | Error = [];
  cancelled: string[] = [];
  reduces: ReduceRequest[] = [];
  override getPosition(): number {
    return this.pos;
  }
  override getAccount() {
    return { equityUsd: this.equity, ts: 0 };
  }
  dataAge() {
    return this.age;
  }
  async listResting(): Promise<string[]> {
    if (this.resting instanceof Error) throw this.resting;
    return this.resting;
  }
  override async cancelAll(m: string): Promise<boolean> {
    this.cancelled.push(m);
    return super.cancelAll(m);
  }
  override async reduce(req: ReduceRequest): Promise<boolean> {
    this.reduces.push(req);
    this.pos = req.side === "sell" ? Math.max(0, this.pos - req.size) : Math.min(0, this.pos + req.size);
    return true;
  }
}

async function build(over: Record<string, unknown> = {}, engineOpts: Record<string, unknown> = {}) {
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
  const mm = new MarketMaker(cfg, ex, specs, { log, rng: () => 0.5, sleep: async () => {}, ...engineOpts });
  const run = async (fromSec: number, toSec: number) => {
    for (let t = fromSec; t < toSec; t += cfg.engine.tickMs / 1000) {
      ex.advance(T0 + t * 1000);
      await mm.step(T0 + t * 1000);
    }
  };
  const ourBids = () => ex.getBook(NAME)!.bids.length - 3; // 3 synthetic venue levels
  return { cfg, ex, mm, logs, run, ourBids };
}
const snap = (mm: MarketMaker, t: number) => mm.snapshot(t) as Record<string, any>;

describe("blind pause and watchdog", () => {
  it("pulls the quotes while positions cannot be read and brings them back afterwards", async () => {
    const h = await build();
    await h.run(0, 3);
    expect(h.ourBids()).toBeGreaterThan(0);
    h.ex.age = { positionsMs: 120_000, accountMs: 100 };
    await h.run(3, 6);
    expect(h.ourBids()).toBe(0);
    expect(h.logs.filter((l) => l.msg.startsWith("blind:"))).toHaveLength(1); // said once, not every tick
    h.ex.age = { positionsMs: 200, accountMs: 100 };
    await h.run(6, 10);
    expect(h.ourBids()).toBeGreaterThan(0);
  });

  it("a stale account read blinds the bot too", async () => {
    const h = await build();
    h.ex.age = { positionsMs: 100, accountMs: 99_000 };
    await h.run(0, 3);
    expect(h.ourBids()).toBe(0);
  });

  it("asks for a restart only after the data has been unusable for the watchdog time", async () => {
    const h = await build({ engine: { watchdogMs: 20_000 } });
    await h.run(0, 3);
    h.ex.age = { positionsMs: 120_000, accountMs: 100 };
    await h.run(3, 15);
    expect(h.mm.restartRequested(T0 + 15_000)).toBe(false);
    await h.run(15, 30);
    expect(h.mm.restartRequested(T0 + 30_000)).toBe(true);
    h.ex.age = { positionsMs: 100, accountMs: 100 };
    await h.run(30, 33);
    expect(h.mm.restartRequested(T0 + 33_000)).toBe(false); // recovered in time
  });

  it("watchdog 0 never asks", async () => {
    const h = await build({ engine: { watchdogMs: 0 } });
    h.ex.age = { positionsMs: 120_000, accountMs: 100 };
    await h.run(0, 60);
    expect(h.mm.restartRequested(T0 + 60_000)).toBe(false);
  });

  it("runLoop ends with a restart, quotes pulled and positions left alone", async () => {
    const h = await build({ engine: { watchdogMs: 5_000 } });
    h.ex.pos = 0.01;
    let t = T0;
    const res = await runLoop({
      mm: h.mm,
      tickMs: 250,
      endsAt: null,
      stopFile: "never",
      log: (l, m, e) => h.logs.push({ level: l, msg: m, extra: e }),
      exists: () => false,
      beforeStep: (now) => {
        h.ex.advance(now);
        if (now - T0 > 2_000) h.ex.age = { positionsMs: 300_000, accountMs: 100 };
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(res).toEqual({ end: "restart", flat: null });
    expect(h.ourBids()).toBe(0);
    expect(h.ex.reduces).toHaveLength(0);
    expect(h.mm.isHalted).toBe(true);
  });
});

describe("daily loss limit and equity floor", () => {
  it("closes the position, stays flat for the rest of the UTC day and quotes again the next day", async () => {
    const h = await build({ risk: { maxDailyLossUsd: 1 } });
    await h.run(0, 5);
    expect(h.ourBids()).toBeGreaterThan(0);
    h.ex.pos = 0.01;
    h.ex.equity = 18.5; // down 1.5 USD on the day
    await h.run(5, 8);
    expect(h.logs.some((l) => l.msg.startsWith("daily loss limit reached"))).toBe(true);
    expect(h.ourBids()).toBe(0);
    expect(h.ex.reduces.length).toBeGreaterThan(0);
    expect(h.ex.pos).toBe(0);
    expect(snap(h.mm, T0 + 8000).phase).toBe("paused");
    const tx = h.ex.txCount;
    await h.run(8, 600);
    expect(h.ex.txCount).toBe(tx); // idle, not even a refresh
    expect(h.mm.isHalted).toBe(false);

    // next UTC day: new baseline, trading resumes by itself
    const nextDay = 19 * 3600; // 06:00 + 19 h = 01:00 next day
    h.ex.equity = 18.5;
    await h.run(nextDay, nextDay + 6);
    expect(h.ourBids()).toBeGreaterThan(0);
    expect(snap(h.mm, T0 + (nextDay + 6) * 1000).phase).toBe("running");
    expect(h.logs.some((l) => l.msg.startsWith("new UTC day: quoting again"))).toBe(true);
  });

  it("widens the quotes slowly while the day's loss runs ahead of its schedule, and relaxes when it catches up", async () => {
    const h = await build({ risk: { maxDailyLossUsd: 2, maxPaceMult: 3 } });
    await h.run(0, 40);
    expect(snap(h.mm, T0 + 40_000).lossPace).toBe(1);
    h.ex.equity = 19.2; // 0.8 USD down by 06:01 with 2 USD allowed per day: well ahead of schedule
    await h.run(40, 400);
    const widened = snap(h.mm, T0 + 400_000).lossPace as number;
    expect(widened).toBeGreaterThan(1.5);
    expect(widened).toBeLessThanOrEqual(3);
    // it moved gradually: no more than 10 % per 30 s
    await h.run(400, 430);
    expect(snap(h.mm, T0 + 430_000).lossPace).toBeLessThanOrEqual(widened * 1.1 + 1e-9);
    h.ex.equity = 20;
    await h.run(430, 1500);
    expect(snap(h.mm, T0 + 1_500_000).lossPace).toBe(1);
    expect(h.mm.isHalted).toBe(false);
  });

  it("no pacing without a daily limit or with maxPaceMult 1", async () => {
    for (const risk of [{ maxDailyLossUsd: 0 }, { maxDailyLossUsd: 2, maxPaceMult: 1 }]) {
      const h = await build({ risk });
      await h.run(0, 10);
      h.ex.equity = 19;
      await h.run(10, 200);
      expect(snap(h.mm, T0 + 200_000).lossPace).toBe(1);
    }
  });

  it("a loss under the limit changes nothing, and 0 disables the limit", async () => {
    const small = await build({ risk: { maxDailyLossUsd: 1 } });
    await small.run(0, 3);
    small.ex.equity = 19.5;
    await small.run(3, 8);
    expect(small.ourBids()).toBeGreaterThan(0);
    const off = await build({ risk: { maxDailyLossUsd: 0 } });
    await off.run(0, 3);
    off.ex.equity = 5;
    await off.run(3, 8);
    expect(off.ourBids()).toBeGreaterThan(0);
  });

  it("a pause already in force survives a restart on the same day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const dir = tmp();
    const over = { risk: { maxDailyLossUsd: 1 }, engine: { stateFile: join(dir, "state.json"), liveFile: join(dir, "live.json"), pointsLogFile: join(dir, "p.csv"), dailyLogFile: join(dir, "d.csv") } };
    const a = await build(over, { persist: true });
    await a.run(0, 3);
    a.ex.equity = 18;
    await a.run(3, 20);
    expect(snap(a.mm, T0 + 20_000).phase).toBe("paused");
    // the process restarts: new engine, same state file
    const b = await build(over, { persist: true });
    b.ex.equity = 18;
    await b.run(0, 10);
    expect(snap(b.mm, T0 + 10_000).phase).toBe("paused");
    expect(b.ourBids()).toBe(0);
  });

  it("halts when equity falls below the floor, even right after a restart", async () => {
    const h = await build({ risk: { minEquityUsd: 15 } });
    await h.run(0, 3);
    expect(h.mm.isHalted).toBe(false);
    h.ex.equity = 14.9;
    await h.run(3, 5);
    expect(h.mm.isHalted).toBe(true);
    expect(h.logs.some((l) => l.msg === "HALT" && String(l.extra?.reason).includes("below the floor"))).toBe(true);
    expect(h.ourBids()).toBe(0);
  });
});

describe("daily summary", () => {
  it("is logged and appended to the csv when a UTC day ends", async () => {
    const dir = tmp();
    const h = await build(
      { paper: { startMid: 2700, annualVolPct: 5, flowPerSec: 0.05, equityUsd: 20, seed: 3 }, engine: { stateFile: join(dir, "state.json"), liveFile: join(dir, "live.json"), pointsLogFile: join(dir, "p.csv"), dailyLogFile: join(dir, "daily.csv") } },
      { persist: true },
    );
    await h.run(0, 600); // fills on 2026-01-01
    await h.run(19 * 3600, 19 * 3600 + 10); // next day
    const row = h.logs.find((l) => l.msg === "daily summary");
    expect(row).toBeDefined();
    expect(row!.extra).toMatchObject({ day: "2026-01-01" });
    expect(Number(row!.extra!.volumeUsd)).toBeGreaterThan(0);
    expect(Number(row!.extra!.fills)).toBeGreaterThan(0);
    const csv = readFileSync(join(dir, "daily.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toContain("day,volumeUsd");
    expect(csv).toHaveLength(2);
    expect(csv[1]).toMatch(/^2026-01-01,/);
  });
});

describe("start-up cleanup", () => {
  it("cancels only the markets that still have quotes resting", async () => {
    const h = await build();
    h.ex.resting = [NAME, "SOL/USD"];
    expect(await h.mm.cleanupLeftovers()).toEqual([NAME]);
    expect(h.ex.cancelled).toEqual([NAME]);
    expect(h.logs.some((l) => l.msg.startsWith("startup: cancelled quotes left behind"))).toBe(true);
  });
  it("does nothing when nothing is resting, and cancels everywhere when the listing fails", async () => {
    const h = await build();
    h.ex.resting = [];
    expect(await h.mm.cleanupLeftovers()).toEqual([]);
    expect(h.ex.cancelled).toEqual([]);
    h.ex.resting = new Error("indexer down");
    expect(await h.mm.cleanupLeftovers()).toEqual([NAME]);
    expect(h.ex.cancelled).toEqual([NAME]);
  });
});

describe("gas runway", () => {
  it("warns when the APT balance will not last three days", async () => {
    const h = await build({ risk: { minGasBalanceApt: 0, maxGasAptPerDay: 100 } });
    let gasApt = 0;
    (h.ex as unknown as { getGas: () => unknown }).getGas = () => ({ txCount: 100, gasApt, balanceApt: 0.5 });
    await h.run(0, 2);
    gasApt = 0.5; // 0.5 APT in the first hour => ~12 APT/day against 0.5 APT in the account
    for (let t = 3600; t < 3600 + 60; t += 0.25) {
      h.ex.advance(T0 + t * 1000);
      await h.mm.step(T0 + t * 1000);
    }
    const w = h.logs.find((l) => l.msg.startsWith("APT for gas is running low"));
    expect(w).toBeDefined();
    expect(Number(w!.extra!.daysLeft)).toBeLessThan(1);
    expect(w!.level).toBe("error");
  });
});

describe("fuse cool-off", () => {
  const cfg = { enabled: true, fastMoveBps: 15, fastWindowMs: 5000, slowMoveBps: 40, slowWindowMs: 60_000, spreadBps: 10, oracleDevBps: 15, cooldownMs: 60_000, maxCooldownMs: 1_800_000, recoverMs: 300_000, recoverWiden: 2, haltAfterTripsPerHour: 3, toxicFills: 5, toxicMarkoutBps: 3 };
  it("halts after too many trips by default", () => {
    const f = new VolatilityFuse(cfg);
    f.trip(0, "a");
    f.trip(1000, "b");
    expect(f.trip(2000, "c")).toMatchObject({ state: "halt" });
  });
  it("in cool-off mode the last trip is a long pause, the history is forgotten and trading resumes", () => {
    const f = new VolatilityFuse({ ...cfg, haltMode: "cooloff", cooloffMs: 3_600_000 });
    f.trip(0, "a");
    f.trip(1000, "b");
    const s = f.trip(2000, "c");
    expect(s).toMatchObject({ state: "tripped" });
    if (s.state === "tripped") {
      expect(s.until - 2000).toBe(3_600_000);
      expect(s.reason).toContain("cooling off 60 min");
    }
    expect(f.observe(2500, { fair: 100, spreadBps: 1, oracleDevBps: 1 }).state).toBe("tripped");
    expect(f.tripsInLastHour).toBe(0);
    const after = f.observe(2000 + 3_600_001, { fair: 100, spreadBps: 1, oracleDevBps: 1 });
    expect(["ok", "recovering"]).toContain(after.state);
    // and it is not halted for good: a later trip is an ordinary one
    expect(f.trip(2000 + 3_700_000, "d")).toMatchObject({ state: "tripped" });
  });
});

describe("run log rotation", () => {
  it("moves the file aside past the size limit and carries the start line over", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = tmp();
    const f = join(dir, "run.log");
    setRunLogFile(f, 1500);
    jsonLogger("info", "market maker started", { pid: 1 });
    for (let i = 0; i < 40; i++) jsonLogger("info", "status", { i, pad: "x".repeat(60) });
    expect(existsSync(`${f}.1`)).toBe(true);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!).msg).toBe("market maker started");
    expect(readFileSync(f, "utf8").length).toBeLessThan(1500 + 300);
    const last = JSON.parse(lines.at(-1)!);
    expect(last.i).toBe(39); // nothing lost at the end
  });
  it("never rotates when the limit is 0", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = tmp();
    const f = join(dir, "run.log");
    setRunLogFile(f, 0);
    for (let i = 0; i < 50; i++) jsonLogger("info", "status", { i, pad: "x".repeat(60) });
    expect(existsSync(`${f}.1`)).toBe(false);
  });
});
