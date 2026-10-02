import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyze, lastRun, parseLog } from "../src/dashboard/analyze.js";
import { startDashboard } from "../src/dashboard/server.js";
import { LogTail } from "../src/dashboard/tail.js";
import { setRunLogFile, jsonLogger } from "../src/engine.js";

const T0 = Date.parse("2026-10-02T10:00:00Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: iso(ms), level, msg, ...extra });

const START = line(0, "info", "market maker started", {
  markets: ["ETH/USD"],
  network: "mainnet",
  dryRun: false,
  marketCfg: [{ name: "ETH/USD", maxPositionUsd: 15, levelSizeUsd: 5, levels: 2 }],
  limits: { maxDrawdownUsd: 1, minGasBalanceApt: 0.03, maxGasAptPerDay: 0.6, rebateBps: 0.5, minMakerRatio: 0.8 },
});

function status(ms: number, over: Record<string, unknown> = {}): string {
  return line(ms, "info", "status", {
    equity: 20.0,
    startEquity: 20.0,
    dayVolumeUsd: 0,
    pnlBps: 0,
    cycleMakerRatio: null,
    takerFills: 0,
    positions: { "ETH/USD": 0 },
    positionsUsd: { "ETH/USD": 0 },
    mids: { "ETH/USD": 2700 },
    quoting: { "ETH/USD": true },
    paused: { "ETH/USD": null },
    txCount: 1,
    gasApt: 0.00185,
    signerAptBalance: 0.19,
    ...over,
  });
}

const fill = (ms: number, side: string, px: number, sz: number, maker: boolean, fee: number): string =>
  line(ms, "info", "fill", { market: "ETH/USD", side, px, sz, maker, fee });

const opts = (nowMs: number, over = {}) => ({ now: T0 + nowMs, staleMs: 120_000, aptUsd: 1, killFile: false, ...over });

describe("parseLog / lastRun", () => {
  it("skips partial and non-JSON lines", () => {
    const text = [START, "npm warn something", '{"t":"2026-10-02T10:00:05.000Z","level":"info","msg":"sta', status(30_000)].join("\n");
    const lines = parseLog(text);
    expect(lines.map((l) => l.msg)).toEqual(["market maker started", "status"]);
  });

  it("keeps only the latest run", () => {
    const lines = parseLog(
      [START, fill(1000, "buy", 2700, 0.001, true, 0.01), line(5000, "info", "market maker started", { dryRun: true }), status(6000)].join("\n"),
    );
    expect(lastRun(lines).map((l) => l.msg)).toEqual(["market maker started", "status"]);
  });
});

describe("analyze", () => {
  const log = [
    START,
    status(30_000),
    line(40_000, "info", "ladder placed", { market: "ETH/USD", sequenceNumber: 7, hash: "0xabc", gasUsed: "185", quotes: { bids: [[2699, 0.001]], asks: [[2701, 0.001]] } }),
    fill(60_000, "buy", 2700, 0.01, true, 0.004), // 27 USD maker
    fill(90_000, "sell", 2702, 0.01, true, 0.004), // 27.02 USD maker
    fill(100_000, "sell", 2700, 0.005, false, 0.006), // 13.5 USD taker
    status(3_600_000, { equity: 20.05, gasApt: 0.01, txCount: 6, signerAptBalance: 0.18, cycleMakerRatio: 0.8, takerFills: 1 }),
  ].join("\n");

  it("reports a running bot and its economics", () => {
    const d = analyze(parseLog(log), opts(3_610_000));
    expect(d.run.state).toBe("running");
    expect(d.run.dryRun).toBe(false);
    expect(d.fills).toMatchObject({ total: 3, maker: 2, taker: 1, buys: 1, sells: 2 });
    expect(d.fills.volumeUsd).toBeCloseTo(27 + 27.02 + 13.5, 6);
    expect(d.fills.makerVolumeUsd).toBeCloseTo(54.02, 6);
    expect(d.fills.feesUsd).toBeCloseTo(0.014, 6);
    expect(d.econ.equityDelta).toBeCloseTo(0.05, 6);
    expect(d.econ.rebateUsd).toBeCloseTo((54.02 * 0.5) / 1e4, 8);
    expect(d.econ.gasUsd).toBeCloseTo(0.01, 8); // 0.01 APT at 1 USD
    expect(d.econ.netUsd).toBeCloseTo(0.05 + (54.02 * 0.5) / 1e4 - 0.01, 6);
    expect(d.econ.gasAptPerHour).toBeCloseTo(0.01, 6);
    expect(d.econ.aptRunwayHours).toBeCloseTo(18, 4);
    expect(d.ladders.placed).toBe(1);
    expect(d.ladders.recent[0]).toMatchObject({ seq: 7, hash: "0xabc", gasUsed: 185, dry: false });
    expect(d.volumeSeries.cumUsd[d.volumeSeries.cumUsd.length - 1]).toBeCloseTo(67.52, 6);
    expect(d.series.equity).toEqual([20, 20.05]);
  });

  it("flags taker fills and a low cycle maker ratio", () => {
    const d = analyze(parseLog(log.replace('"cycleMakerRatio":0.8', '"cycleMakerRatio":0.5')), opts(3_610_000));
    const text = d.alerts.map((a) => a.text).join(" | ");
    expect(text).toContain("50.0%");
    expect(text).toContain("taker");
  });

  it("flags stale logs and keeps the on-chain warning", () => {
    const d = analyze(parseLog(log), opts(3_600_000 + 300_000));
    expect(d.run.state).toBe("stale");
    expect(d.alerts[0]!.level).toBe("error");
    expect(d.alerts[0]!.text).toContain("Open Orders");
  });

  it("recognises a clean stop and a halt", () => {
    const stopped = analyze(parseLog(log + "\n" + line(3_700_000, "warn", "shutting down, cancelling quotes", { sig: "SIGTERM" })), opts(4_000_000));
    expect(stopped.run.state).toBe("stopped");
    const halted = analyze(parseLog(log + "\n" + line(3_700_000, "error", "HALT", { reason: "drawdown" })), opts(3_701_000));
    expect(halted.run.state).toBe("halted");
    expect(halted.run.detail).toContain("drawdown");
  });

  it("warns about low APT, drawdown, KILL file and an active fuse", () => {
    const l = [
      START,
      status(30_000),
      line(100_000, "warn", "FUSE tripped: pulling quotes", { market: "ETH/USD", reason: "range 20 bps in 5s", pauseSec: 60 }),
      status(110_000, { equity: 19.4, signerAptBalance: 0.05 }),
    ].join("\n");
    const d = analyze(parseLog(l), opts(120_000, { killFile: true }));
    const text = d.alerts.map((a) => a.text).join(" | ");
    expect(text).toContain("KILL");
    expect(text).toContain("0.0500");
    expect(text).toContain("60%");
    expect(text).toContain("Cầu chì");
    expect(d.counters.fuseTrips).toBe(1);
  });

  it("handles an empty log", () => {
    const d = analyze([], opts(0));
    expect(d.run.state).toBe("no-data");
    expect(d.econ.netUsd).toBeNull();
  });

  it("reports a dry run and its (unsent) ladders", () => {
    const l = [
      line(0, "info", "market maker started", { dryRun: true, markets: ["ETH/USD"] }),
      line(1000, "info", "DRY-RUN place_bulk_orders", { market: "ETH/USD", sequenceNumber: 1, quotes: { bids: [[2699, 0.001]], asks: [[2701, 0.001]] } }),
    ].join("\n");
    const d = analyze(parseLog(l), opts(2000));
    expect(d.run.dryRun).toBe(true);
    expect(d.ladders).toMatchObject({ placed: 0, dry: 1 });
  });
});

describe("dashboard server", () => {
  const dirs: string[] = [];
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    setRunLogFile(null);
  });

  it("serves the page and data on the loopback interface only, read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-dash-"));
    dirs.push(dir);
    const logFile = join(dir, "run.log");
    writeFileSync(logFile, [START, status(30_000)].join("\n") + "\n");
    const srv = await startDashboard({ port: 0, logFile, killFile: join(dir, "KILL"), staleMs: 1e12, priceFeed: null });
    servers.push(srv);
    const addr = srv.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${addr.port}`;

    const page = await fetch(base + "/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Decibel MM");

    const data = (await (await fetch(base + "/api/data?apt=2")).json()) as ReturnType<typeof analyze>;
    expect(data.run.state).toBe("running");
    expect(data.econ.aptUsd).toBe(2);

    appendFileSync(logFile, fill(40_000, "buy", 2700, 0.01, true, 0.004) + "\n");
    const again = (await (await fetch(base + "/api/data")).json()) as ReturnType<typeof analyze>;
    expect(again.fills.total).toBe(1);

    expect((await fetch(base + "/api/data", { method: "POST" })).status).toBe(405);
    expect((await fetch(base + "/nope")).status).toBe(404);
  });

  it("answers with an empty state when no log exists yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-dash-"));
    dirs.push(dir);
    const srv = await startDashboard({ port: 0, logFile: join(dir, "missing.log"), killFile: join(dir, "KILL"), priceFeed: null });
    servers.push(srv);
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const data = (await (await fetch(base + "/api/data")).json()) as ReturnType<typeof analyze>;
    expect(data.run.state).toBe("no-data");
  });

  it("reads only the tail of a large file on first load, from a line boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-dash-"));
    dirs.push(dir);
    const f = join(dir, "big.log");
    const rows = Array.from({ length: 200 }, (_, i) => line(i * 1000, "info", "tick", { i, pad: "x".repeat(40) }));
    writeFileSync(f, rows.join("\n") + "\n");
    const lines = new LogTail(f, 2000).read();
    expect(lines[lines.length - 1]!.i).toBe(199);
    expect(lines.length).toBeLessThan(200);
    expect(lines.length).toBeGreaterThan(5);
  });

  it("the bot's logger mirrors every line into the run log", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-dash-"));
    dirs.push(dir);
    const f = join(dir, "sub", "run.log");
    setRunLogFile(f);
    const orig = console.log;
    console.log = () => {};
    try {
      jsonLogger("warn", "hello", { a: 1 });
    } finally {
      console.log = orig;
    }
    const lines = parseLog(readFileSync(f, "utf8"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", msg: "hello", a: 1 });
  });
});
