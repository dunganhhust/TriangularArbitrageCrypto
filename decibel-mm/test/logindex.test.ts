import { describe, expect, it } from "vitest";
import { LogIndex, analyze, parseLog } from "../src/dashboard/analyze.js";
import type { LogLine } from "../src/dashboard/analyze.js";
import { RunIndex } from "../src/dashboard/logindex.js";

const T0 = Date.parse("2026-10-04T00:00:00Z");
const S = 1000;
const mk = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): LogLine => ({ t: new Date(T0 + ms).toISOString(), ts: T0 + ms, level, msg, ...extra });
const START = (ms: number, attempt: number | null = null): LogLine =>
  mk(ms, "info", "market maker started", { markets: ["ETH/USD"], network: "mainnet", dryRun: false, pid: 1, supervisedAttempt: attempt, marketCfg: [{ name: "ETH/USD", maxPositionUsd: 30, levelSizeUsd: 10 }], limits: { maxDrawdownUsd: 4, rebateBps: 0.5, minMakerRatio: 0.8 } });
const STATUS = (ms: number, eq: number, extra: Record<string, unknown> = {}): LogLine =>
  mk(ms, "info", "status", { equity: eq, startEquity: 20, gasApt: ms / 1e7, txCount: Math.floor(ms / 1e4), positionsUsd: { "ETH/USD": 5 }, mids: { "ETH/USD": 2700 }, ...extra });
const FILL = (ms: number, maker = true): LogLine => mk(ms, "info", "fill", { market: "ETH/USD", side: "buy", px: 2700, sz: 0.004, maker, fee: 0.0016 });
const LADDER = (ms: number, market = "ETH/USD"): LogLine => mk(ms, "info", "ladder placed", { market, sequenceNumber: ms, hash: "0x" + ms, gasUsed: "270", path: "plain", quotes: { bids: [[2699, 0.004]], asks: [[2701, 0.004]] } });

function session(minutes: number): LogLine[] {
  const out: LogLine[] = [START(0)];
  for (let m = 0; m < minutes; m++) {
    const t = m * 60 * S;
    out.push(STATUS(t + 30 * S, 20 - m * 0.0001));
    if (m % 2 === 0) out.push(FILL(t + 10 * S, m % 7 !== 0));
    if (m % 3 === 0) out.push(LADDER(t + 20 * S));
    if (m === 10) out.push(mk(t, "warn", "FUSE tripped: pulling quotes", { market: "ETH/USD", reason: "x", pauseSec: 60 }));
    if (m === 20) out.push(mk(t, "warn", "pause", { market: "ETH/USD", reason: "stale book" }));
  }
  return out;
}
const opts = (now: number, extra: Record<string, unknown> = {}) => ({ now: T0 + now, staleMs: 120_000, aptUsd: 0.8, killFile: false, ...extra });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("LogIndex", () => {
  it("gives the same analysis whether it is built in one go, line by line, or in chunks", () => {
    const lines = session(180);
    const bulk = LogIndex.from(lines);
    const inc = new LogIndex();
    for (const l of lines) inc.add([l]);
    const chunked = new LogIndex();
    for (let i = 0; i < lines.length; i += 17) chunked.add(lines.slice(i, i + 17));
    for (const range of [null, 3600_000, 900_000]) {
      const o = opts(181 * 60 * S, { rangeMs: range });
      const want = JSON.stringify(analyze(lines, o));
      expect(JSON.stringify(analyze(bulk, o))).toBe(want);
      expect(JSON.stringify(analyze(inc, o))).toBe(want);
      expect(JSON.stringify(analyze(chunked, o))).toBe(want);
    }
  });

  it("windows look only at what falls inside them", () => {
    const idx = LogIndex.from(session(180));
    const d1h = analyze(idx, opts(181 * 60 * S, { rangeMs: 3600_000 }));
    const dAll = analyze(idx, opts(181 * 60 * S));
    expect(d1h.fills.total).toBeLessThan(dAll.fills.total);
    expect(d1h.fills.total).toBeGreaterThan(0);
    expect(d1h.series.t.length).toBeLessThan(dAll.series.t.length);
    expect(d1h.window.from).toBeGreaterThanOrEqual(T0 + 119 * 60 * S); // an hour before the last line (at 179 min 30 s)
    // counters of warnings, fuse trips and pauses honour the window
    expect(dAll.counters.fuseTrips).toBe(1);
    expect(d1h.counters.fuseTrips).toBe(0);
    expect(dAll.counters.pauses).toBe(1);
  });

  it("starts a new run at every marker and keeps per-run totals", () => {
    const first = session(10);
    first[0] = START(0, 1);
    const lines = [...first, START(11 * 60 * S, 2), STATUS(12 * 60 * S, 19.9), FILL(12.5 * 60 * S)];
    const idx = LogIndex.from(lines);
    expect(idx.all).toHaveLength(2);
    expect(idx.all[0]!.fillCount).toBe(5);
    expect(idx.all[1]!.fillCount).toBe(1);
    const d = analyze(idx, opts(13 * 60 * S));
    expect(d.runs).toHaveLength(2);
    expect(d.runs[0]!.attempt).toBe(2);
    expect(d.runs[1]!.outcome).toBe("restarted"); // the first process has no closing line and attempt 2 follows it
  });

  it("a log with no start marker is one run; markers that arrive later replace it", () => {
    const idx = new LogIndex();
    idx.add([STATUS(1000, 20), FILL(2000)]);
    expect(idx.all).toHaveLength(1);
    expect(idx.all[0]!.start).toBeNull();
    idx.add([START(3000), STATUS(4000, 19)]);
    expect(idx.all).toHaveLength(1);
    expect(idx.all[0]!.start).not.toBeNull();
    expect(idx.total).toBe(4);
  });

  it("copes with lines that arrive slightly out of order", () => {
    const idx = LogIndex.from([START(0), STATUS(10 * S, 20), STATUS(9 * S, 20.5), STATUS(20 * S, 19), FILL(15 * S), FILL(14 * S)]);
    const w = idx.all[0]!.window("statuses", T0 + 10 * S);
    expect(w.map((l) => l.ts - T0)).toEqual([10 * S, 20 * S]);
    // Same answer as the scan it replaces: the last line in log order that qualifies.
    expect(idx.all[0]!.lastBefore("statuses", T0 + 10 * S)?.ts).toBe(T0 + 9 * S);
    expect(idx.all[0]!.lastBefore("statuses", T0 + 10 * S, true)?.ts).toBe(T0 + 9 * S);
  });

  it("drops the order-book detail of old ladders but keeps the latest per market", () => {
    const idx = new LogIndex();
    idx.add([START(0)]);
    for (let i = 0; i < 100; i++) idx.add([LADDER(i * S, i % 2 ? "ETH/USD" : "BTC/USD")]);
    const run = idx.all[0]!;
    const withQuotes = run.placed.filter((l) => l.quotes !== undefined).length;
    expect(withQuotes).toBeLessThanOrEqual(32);
    expect(run.lastQuoted.get("ETH/USD")?.quotes).toBeDefined();
    expect(run.lastQuoted.get("BTC/USD")?.quotes).toBeDefined();
    expect(run.placed[0]!.quotes).toBeUndefined();
  });

  it("does not keep lines the page never shows", () => {
    const idx = new LogIndex();
    idx.add([START(0)]);
    for (let i = 0; i < 1000; i++) idx.add([mk(i * S, "info", "points", { a: i }), mk(i * S, "info", "units", { b: i })]);
    expect(idx.total).toBe(2001);
    expect(idx.retained).toBe(1); // only the start marker
  });

  it("trims the oldest runs first, then the oldest part of a single huge run, and keeps whole-run totals", () => {
    const idx = new LogIndex();
    for (let r = 0; r < 5; r++) {
      idx.add([START(r * 1e7)]);
      for (let i = 0; i < 500; i++) idx.add([STATUS(r * 1e7 + (i + 1) * S, 20)]);
    }
    idx.trim(1000); // 2505 retained > 1250: drop whole runs until about 800 remain
    expect(idx.all.length).toBeLessThan(5);
    expect(idx.all.at(-1)!.startedAt).toBe(T0 + 4 * 1e7); // the newest run survives

    const big = new LogIndex();
    big.add([START(0)]);
    for (let i = 0; i < 5000; i++) big.add([i % 2 ? FILL((i + 1) * S) : STATUS((i + 1) * S, 20)]);
    big.trim(2000);
    const run = big.all[0]!;
    expect(run.retained).toBeLessThan(2100);
    expect(run.fillCount).toBe(2500); // totals are for the whole run
    expect(run.fills[0]!.ts).toBeGreaterThan(T0 + 1000 * S);
    expect(run.notable.includes(run.start!)).toBe(true); // the start marker stays visible
    const d = analyze(big, opts(5001 * S));
    expect(d.runs[0]!.fills).toBe(2500);
  });

  it("indexing and a one-hour query stay cheap on a month of 24/7 logging", () => {
    const lines: LogLine[] = [START(0)];
    const n = 30 * 24 * 60; // one minute steps for 30 days
    for (let m = 1; m <= n; m++) {
      lines.push(STATUS(m * 60 * S, 20));
      if (m % 2 === 0) lines.push(FILL(m * 60 * S + 1));
      if (m % 2 === 1) lines.push(LADDER(m * 60 * S + 2));
    }
    const t0 = performance.now();
    const idx = new LogIndex();
    for (let i = 0; i < lines.length; i += 500) {
      idx.add(lines.slice(i, i + 500));
      idx.trim(150_000);
    }
    const build = performance.now() - t0;
    expect(idx.retained).toBeLessThanOrEqual(150_000 * 1.25);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) analyze(idx, opts((n + 1) * 60 * S, { rangeMs: 3600_000 }));
    const perCall = (performance.now() - t1) / 20;
    expect(perCall).toBeLessThan(40); // measured ~1 ms; the budget is generous so a slow machine does not flake
    expect(build).toBeLessThan(8000);
  });
});

describe("RunIndex as a stand-alone summary", () => {
  it("summarizes a run given as plain lines, like the old function did", async () => {
    const { summarizeRun } = await import("../src/dashboard/analyze.js");
    const lines = parseLog(session(5).map((l) => JSON.stringify(l)).join("\n"));
    const sum = summarizeRun(lines, false, T0 + 600 * S, 120_000);
    expect(sum.fills).toBe(3);
    expect(sum.outcome).toBe("unknown");
    expect(sum.markets).toEqual(["ETH/USD"]);
    expect(new RunIndex(null).startedAt).toBeNull();
  });
});
