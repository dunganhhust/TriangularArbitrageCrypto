import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyze, parseLog, splitRuns } from "../src/dashboard/analyze.js";
import type { DashboardData } from "../src/dashboard/analyze.js";
import { startDashboard } from "../src/dashboard/server.js";

const T0 = Date.parse("2026-10-02T10:00:00Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: iso(ms), level, msg, ...extra });
const status = (ms: number, equity: number, over: Record<string, unknown> = {}): string =>
  line(ms, "info", "status", { equity, startEquity: 20, gasApt: 0.01, txCount: 5, positions: { "ETH/USD": 0 }, positionsUsd: { "ETH/USD": 0 }, mids: { "ETH/USD": 2700 }, ...over });
const fill = (ms: number, px: number, sz: number): string => line(ms, "info", "fill", { market: "ETH/USD", side: "buy", px, sz, maker: true, fee: 0.001 });

// Run A: 2 h real, ended by the deadline with everything closed.
// Run B: 10 min real, ended with a position still open.
// Run C: a 3 min dry run killed by a signal.
// Run D (latest): running now.
const A = 0;
const B = 3 * 60 * MIN;
const C = 4 * 60 * MIN;
const D = 5 * 60 * MIN;
const LOG = [
  line(A, "info", "market maker started", { markets: ["ETH/USD"], dryRun: false, pid: 1, endsAt: iso(A + 120 * MIN) }),
  fill(A + 5 * MIN, 2700, 0.01), // 27
  status(A + 60 * MIN, 19.9, { gasApt: 0.05, txCount: 40 }),
  line(A + 120 * MIN, "warn", "run ending: pulling quotes and closing every position", { reason: "deadline" }),
  line(A + 120 * MIN + 3000, "info", "run finished", { reason: "deadline", flat: true, residual: {}, dust: {} }),
  line(B, "info", "market maker started", { markets: ["ETH/USD", "BTC/USD"], dryRun: false, pid: 2, endsAt: iso(B + 10 * MIN) }),
  fill(B + MIN, 2700, 0.005), // 13.5
  fill(B + 2 * MIN, 2700, 0.005), // 13.5
  status(B + 5 * MIN, 19.8),
  line(B + 10 * MIN, "error", "run finished", { reason: "deadline", flat: false, residual: { "ETH/USD": 0.0017 }, dust: {} }),
  line(C, "info", "market maker started", { markets: ["ETH/USD"], dryRun: true, pid: 3 }),
  status(C + MIN, 19.8),
  line(C + 2 * MIN, "warn", "shutting down, cancelling quotes", { sig: "SIGTERM" }),
  line(D, "info", "market maker started", { markets: ["ETH/USD"], dryRun: false, pid: 4, endsAt: iso(D + 60 * MIN) }),
  fill(D + MIN, 2700, 0.002), // 5.4
  status(D + 2 * MIN, 19.85, { gasApt: 0.002, txCount: 2 }),
].join("\n");

const opts = (nowMs: number, over: Record<string, unknown> = {}) => ({ now: T0 + nowMs, staleMs: 120_000, aptUsd: 1, killFile: false, ...over });

describe("run history", () => {
  const lines = parseLog(LOG);

  it("splits the log into runs, oldest first, dropping a partial run cut off at the start", () => {
    expect(splitRuns(lines)).toHaveLength(4);
    const cut = parseLog([status(0, 20), line(MIN, "info", "market maker started", { pid: 9 }), status(2 * MIN, 20)].join("\n"));
    expect(splitRuns(cut)).toHaveLength(1);
    expect(splitRuns(parseLog(status(0, 20)))).toHaveLength(1); // no marker at all: one run
  });

  it("lists every run, newest first, with how each ended", () => {
    const d = analyze(lines, opts(D + 3 * MIN));
    expect(d.runs.map((r) => r.outcome)).toEqual(["running", "signal", "residual", "closed"]);
    const [run4, run3, run2, run1] = d.runs;
    expect(run1).toMatchObject({ id: T0 + A, dryRun: false, plannedMinutes: 120, fills: 1, reason: "deadline" });
    expect(run1!.volumeUsd).toBeCloseTo(27, 6);
    expect(run1!.equityDelta).toBeCloseTo(-0.1, 6); // 19.9 against the 20 it started with
    expect(run1!.gasApt).toBeCloseTo(0.05, 8);
    expect(run2).toMatchObject({ markets: ["ETH/USD", "BTC/USD"], fills: 2, residual: { "ETH/USD": 0.0017 } });
    expect(run2!.volumeUsd).toBeCloseTo(27, 6);
    expect(run3).toMatchObject({ dryRun: true, fills: 0 });
    expect(run4).toMatchObject({ id: T0 + D, plannedMinutes: 60 });
  });

  it("shows the latest run by default and any earlier run on request", () => {
    const now = D + 3 * MIN;
    const latest = analyze(lines, opts(now));
    expect(latest.run).toMatchObject({ isLatest: true, id: T0 + D, state: "running" });
    expect(latest.fills.total).toBe(1);

    const old = analyze(lines, opts(now, { runStart: T0 + A }));
    expect(old.run).toMatchObject({ isLatest: false, id: T0 + A, state: "stopped" });
    expect(old.run.finish).toMatchObject({ closed: true, reason: "deadline" });
    expect(old.fills.total).toBe(1);
    expect(old.fills.volumeUsd).toBeCloseTo(27, 6);
    expect(old.window.from).toBe(T0 + A);
    expect(old.econ.gasApt).toBeCloseTo(0.05, 8);
    expect(old.runs).toHaveLength(4); // the history is the same whichever run is open
  });

  it("an older run with a position left open still says so", () => {
    const d = analyze(lines, opts(D + 3 * MIN, { runStart: T0 + B }));
    expect(d.run.finish).toMatchObject({ closed: false, residual: { "ETH/USD": 0.0017 } });
    expect(d.alerts.map((a) => a.text).join(" ")).toContain("còn vị thế chưa đóng");
  });

  it("an older run without an end line is 'stopped', never 'stale' or 'running'", () => {
    const d = analyze(lines, opts(D + 3 * MIN, { runStart: T0 + C }));
    expect(d.run.state).toBe("stopped");
    expect(d.run.isLatest).toBe(false);
  });

  it("a live snapshot belongs to the latest run only", () => {
    const live = { t: iso(D + 3 * MIN - 1000), pid: 1, equity: 99 }; // same pid as run A, written long after it
    const d = analyze(lines, opts(D + 3 * MIN, { runStart: T0 + A, live }));
    expect(d.run.liveSeen).toBe(false);
    expect(d.latest!.equity).toBe(19.9);
  });

  it("an unknown run id falls back to the latest", () => {
    const d = analyze(lines, opts(D + 3 * MIN, { runStart: 12345 }));
    expect(d.run.isLatest).toBe(true);
  });
});

describe("run selection over HTTP", () => {
  let dir: string;
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serves the history and an old run through ?run=", async () => {
    dir = mkdtempSync(join(tmpdir(), "mm-runs-"));
    const logFile = join(dir, "run.log");
    writeFileSync(logFile, LOG + "\n");
    const srv = await startDashboard({ port: 0, logFile, killFile: join(dir, "KILL"), priceFeed: null, staleMs: 1e13 });
    servers.push(srv);
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const latest = (await (await fetch(base + "/api/data")).json()) as DashboardData;
    expect(latest.runs).toHaveLength(4);
    expect(latest.run.isLatest).toBe(true);
    const old = (await (await fetch(`${base}/api/data?run=${T0 + A}`)).json()) as DashboardData;
    expect(old.run).toMatchObject({ isLatest: false, id: T0 + A });
    const junk = (await (await fetch(`${base}/api/data?run=abc`)).json()) as DashboardData;
    expect(junk.run.isLatest).toBe(true);
  });
});
