import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import { analyze, parseLog } from "../src/dashboard/analyze.js";
import { DEFAULT_SOURCES, PriceFeed } from "../src/dashboard/price.js";
import { LiveFile, LogTail } from "../src/dashboard/tail.js";
import { MarketMaker } from "../src/engine.js";
import { PaperExchange } from "../src/exchange/paper.js";

const T0 = Date.parse("2026-10-02T10:00:00Z");
const H = 3_600_000;
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: iso(ms), level, msg, ...extra });

const START = line(0, "info", "market maker started", {
  markets: ["BTC/USD", "ETH/USD"],
  network: "mainnet",
  dryRun: false,
  pid: 4242,
  marketCfg: [
    { name: "BTC/USD", maxPositionUsd: 20, levelSizeUsd: 6, levels: 2 },
    { name: "ETH/USD", maxPositionUsd: 15, levelSizeUsd: 5, levels: 2 },
  ],
  limits: { maxDrawdownUsd: 1, minGasBalanceApt: 0.03, maxGasAptPerDay: 1.5, rebateBps: 0.5, minMakerRatio: 0.8 },
});

function status(ms: number, over: Record<string, unknown> = {}): string {
  return line(ms, "info", "status", {
    equity: 20,
    startEquity: 20,
    sizeMult: 0.5,
    takerFills: 0,
    positions: { "BTC/USD": 0, "ETH/USD": 0 },
    positionsUsd: { "BTC/USD": 0, "ETH/USD": 0 },
    mids: { "BTC/USD": 60000, "ETH/USD": 2700 },
    quoting: { "BTC/USD": true, "ETH/USD": true },
    paused: { "BTC/USD": null, "ETH/USD": null },
    txCount: 0,
    gasApt: 0,
    signerAptBalance: 1.2,
    ...over,
  });
}

const fill = (ms: number, market: string, side: string, px: number, sz: number, maker = true): string =>
  line(ms, "info", "fill", { market, side, px, sz, maker, fee: +(px * sz * 0.00015).toFixed(5) });

const opts = (nowMs: number, over: Record<string, unknown> = {}) => ({ now: T0 + nowMs, staleMs: 120_000, aptUsd: 1, killFile: false, ...over });

// Three hours of a two-market run.
const LOG = [
  START,
  status(0, { equity: 20 }),
  fill(0.2 * H, "ETH/USD", "buy", 2700, 0.01), // 27 USD, outside a 1 h window
  status(1 * H, { equity: 20.1, txCount: 10, gasApt: 0.02 }),
  fill(1.5 * H, "BTC/USD", "sell", 60000, 0.0005), // 30 USD
  line(1.6 * H, "warn", "pause", { market: "BTC/USD", reason: "wide book" }),
  line(1.7 * H, "warn", "taker fill: paid the taker fee and lowered the maker share", { market: "ETH/USD" }),
  status(2 * H, { equity: 20.2, txCount: 22, gasApt: 0.04 }),
  fill(2.5 * H, "ETH/USD", "sell", 2700, 0.02, false), // 54 USD taker
  line(2.6 * H, "info", "ladder placed", { market: "ETH/USD", sequenceNumber: 9, hash: "0xabc", gasUsed: "185", quotes: { bids: [[2699, 0.002]], asks: [[2701, 0.002]] } }),
  line(2.7 * H, "info", "ladder placed", { market: "BTC/USD", sequenceNumber: 10, hash: "0xdef", gasUsed: "190" }),
  status(3 * H, { equity: 20.25, txCount: 34, gasApt: 0.06, positionsUsd: { "BTC/USD": -30, "ETH/USD": 54 } }),
].join("\n");

describe("windows and market filter", () => {
  const lines = parseLog(LOG);

  it("defaults to the whole run", () => {
    const d = analyze(lines, opts(3 * H));
    expect(d.window.ms).toBeNull();
    expect(d.fills.total).toBe(3);
    expect(d.econ.volumeUsd).toBeCloseTo(27 + 30 + 54, 6);
    expect(d.econ.equityDelta).toBeCloseTo(0.25, 6);
    expect(d.econ.gasApt).toBeCloseTo(0.06, 8);
    expect(d.run.markets).toEqual(["BTC/USD", "ETH/USD"]);
  });

  it("limits tables, totals and economics to the last hour", () => {
    const d = analyze(lines, opts(3 * H, { rangeMs: 1 * H }));
    expect(d.window.from).toBe(T0 + 2 * H);
    expect(d.fills.total).toBe(1); // only the 2.5 h taker fill
    expect(d.fills.taker).toBe(1);
    expect(d.ladders.total).toBe(2);
    expect(d.events.rows.map((e) => e.msg)).not.toContain("pause"); // 1.6 h is outside
    // Equity and gas are measured against the status at the window start (2 h).
    expect(d.econ.equityStart).toBeCloseTo(20.2, 6);
    expect(d.econ.equityDelta).toBeCloseTo(0.05, 6);
    expect(d.econ.gasApt).toBeCloseTo(0.02, 8);
    expect(d.econ.txCount).toBe(12);
    expect(d.econ.gasAptPerHour).toBeCloseTo(0.02, 6);
    expect(d.series.t[0]).toBe(T0 + 2 * H); // chart starts at the window edge
    expect(d.volumeSeries.cumUsd[0]).toBe(0);
    expect(d.volumeSeries.cumUsd[d.volumeSeries.cumUsd.length - 1]).toBeCloseTo(54, 6);
  });

  it("a window longer than the run is the whole run", () => {
    const d = analyze(lines, opts(3 * H, { rangeMs: 48 * H }));
    expect(d.window.from).toBe(T0);
    expect(d.fills.total).toBe(3);
  });

  it("filters tables and charts by market but keeps the economics account-wide", () => {
    const d = analyze(lines, opts(3 * H, { market: "BTC/USD" }));
    expect(d.fills.recent.map((f) => f.market)).toEqual(["BTC/USD"]);
    expect(d.ladders.recent.map((l) => l.market)).toEqual(["BTC/USD"]);
    expect(d.events.rows.map((e) => e.msg)).toContain("pause");
    expect(d.events.rows.map((e) => e.msg)).not.toContain("taker fill: paid the taker fee and lowered the maker share");
    expect(d.markets.map((m) => m.name)).toEqual(["BTC/USD"]);
    expect(Object.keys(d.volumeByMarket)).toEqual(["BTC/USD"]);
    expect(d.series.positionUsd[d.series.positionUsd.length - 1]).toBe(-30);
    expect(d.econ.volumeUsd).toBeCloseTo(111, 6); // both markets
  });

  it("reports each market's totals, position and cap in force", () => {
    const d = analyze(lines, opts(3 * H));
    const eth = d.markets.find((m) => m.name === "ETH/USD")!;
    const btc = d.markets.find((m) => m.name === "BTC/USD")!;
    expect(eth).toMatchObject({ fills: 2, maker: 1, taker: 1, positionUsd: 54, capUsd: 7.5 }); // 15 * ramp 0.5
    expect(btc).toMatchObject({ fills: 1, positionUsd: -30, capUsd: 10 });
    expect(btc.volumeUsd).toBeCloseTo(30, 6);
  });
});

describe("live snapshot", () => {
  const live = (over: Record<string, unknown> = {}) => ({
    t: iso(3 * H + 5_000),
    pid: 4242,
    equity: 20.3,
    startEquity: 20,
    sizeMult: 0.5,
    gasApt: 0.061,
    txCount: 35,
    signerAptBalance: 1.19,
    markets: {
      "ETH/USD": {
        mid: 2701.5, bid: 2701.4, ask: 2701.6, spreadBps: 0.74, position: 0.02, positionUsd: 54.03,
        quoting: true, paused: null, fuse: "ok", fuseUntil: null, fuseReason: null,
        quotes: { bids: [[2699.9, 0.0018]], asks: [[2703.1, 0.0018]] },
      },
      "BTC/USD": { mid: 60010, bid: 60009, ask: 60011, spreadBps: 0.33, position: -0.0005, positionUsd: -30, quoting: false, paused: "wide book", fuse: "tripped", fuseUntil: T0 + 3 * H + 60_000, fuseReason: "range" },
    },
    ...over,
  });

  it("overrides the last status line and feeds the market cards", () => {
    const d = analyze(parseLog(LOG), opts(3 * H + 6_000, { live: live() }));
    expect(d.run.liveSeen).toBe(true);
    expect(d.latest!.equity).toBe(20.3);
    expect(d.econ.equityNow).toBe(20.3);
    const eth = d.markets.find((m) => m.name === "ETH/USD")!;
    expect(eth).toMatchObject({ mid: 2701.5, bid: 2701.4, ask: 2701.6, spreadBps: 0.74, fuse: "ok" });
    expect(eth.quotes!.bids[0]).toEqual([2699.9, 0.0018]);
    const btc = d.markets.find((m) => m.name === "BTC/USD")!;
    expect(btc).toMatchObject({ quoting: false, paused: "wide book", fuse: "tripped" });
    expect(d.alerts.map((a) => a.text).join(" | ")).toContain("BTC/USD đang tạm dừng báo giá: wide book");
    expect(d.series.equity[d.series.equity.length - 1]).toBe(20.3); // live point closes the chart
  });

  it("goes stale within seconds of the snapshot stopping, not minutes", () => {
    const d = analyze(parseLog(LOG), opts(3 * H + 5_000 + 20_000, { live: live() }));
    expect(d.run.state).toBe("stale");
    const fine = analyze(parseLog(LOG), opts(3 * H + 5_000 + 10_000, { live: live() }));
    expect(fine.run.state).toBe("running");
  });

  it("ignores a snapshot from another process or an older run", () => {
    const other = analyze(parseLog(LOG), opts(3 * H + 6_000, { live: live({ pid: 1 }) }));
    expect(other.run.liveSeen).toBe(false);
    expect(other.latest!.equity).toBe(20.25); // last status line
    const old = analyze(parseLog(LOG), opts(3 * H + 6_000, { live: live({ t: iso(-5 * H) }) }));
    expect(old.run.liveSeen).toBe(false);
  });
});

describe("APT price feed", () => {
  const json = (v: unknown, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => v });

  it("parses each public endpoint's response shape", () => {
    const by = Object.fromEntries(DEFAULT_SOURCES.map((s) => [s.name, s]));
    expect(by.Coinbase!.parse({ data: { amount: "0.8123", currency: "USD" } })).toBeCloseTo(0.8123);
    expect(by.Kraken!.parse({ result: { APTUSD: { c: ["0.8101", "10"] } } })).toBeCloseTo(0.8101);
    expect(by.Binance!.parse({ symbol: "APTUSDT", price: "0.8090" })).toBeCloseTo(0.809);
    expect(by.CoinGecko!.parse({ aptos: { usd: 0.8055 } })).toBeCloseTo(0.8055);
  });

  it("falls through to the next source and remembers the one that worked", async () => {
    const calls: string[] = [];
    const feed = new PriceFeed({
      sources: [
        { name: "A", url: "http://a", parse: () => null },
        { name: "B", url: "http://b", parse: (j) => Number((j as { p: string }).p) },
      ],
      fetchFn: async (u) => {
        calls.push(u);
        return u === "http://a" ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ p: "0.9" }) };
      },
      cooldownMs: 60_000,
    });
    await feed.refresh();
    expect(feed.get()).toMatchObject({ usd: 0.9, source: "B", stale: false });
    calls.length = 0;
    await feed.refresh();
    expect(calls).toEqual(["http://b"]); // B first now; A is cooling down
  });

  it("rejects absurd prices and keeps the previous reading", async () => {
    let price = "0.85";
    const feed = new PriceFeed({ sources: [{ name: "A", url: "http://a", parse: (j) => Number((j as { p: string }).p) }], fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ p: price }) }), cooldownMs: 0 });
    await feed.refresh();
    price = "0";
    await feed.refresh();
    price = "not-a-number";
    await feed.refresh();
    expect(feed.get()!.usd).toBe(0.85);
  });

  it("marks the reading stale when it stops updating, and returns null before any success", async () => {
    let now = 1_000_000;
    const feed = new PriceFeed({ sources: [{ name: "A", url: "http://a", parse: () => 0.8 }], fetchFn: json({}), now: () => now });
    expect(feed.get()).toBeNull();
    await feed.refresh();
    expect(feed.get()!.stale).toBe(false);
    now += 60_000;
    expect(feed.get()).toMatchObject({ stale: true, ageSec: 60 });
  });

  it("returns null when every source fails", async () => {
    const feed = new PriceFeed({ sources: [{ name: "A", url: "http://a", parse: () => 1 }], fetchFn: async () => { throw new Error("blocked"); } });
    await feed.refresh();
    expect(feed.get()).toBeNull();
  });
});

describe("incremental log tail", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "mm-tail-"));
    dirs.push(d);
    return join(d, "run.log");
  };

  it("picks up appended lines, waits for a half-written line, and follows a restart", () => {
    const f = tmp();
    writeFileSync(f, START + "\n" + status(1000) + "\n");
    const tail = new LogTail(f);
    expect(tail.read().map((l) => l.msg)).toEqual(["market maker started", "status"]);

    const half = fill(2000, "ETH/USD", "buy", 2700, 0.01);
    appendFileSync(f, half.slice(0, 20)); // writer is mid-line
    expect(tail.read()).toHaveLength(2);
    appendFileSync(f, half.slice(20) + "\n");
    expect(tail.read().map((l) => l.msg)).toEqual(["market maker started", "status", "fill"]);

    // A new run is added after the old one; the old one stays available for the history.
    appendFileSync(f, line(5000, "info", "market maker started", { pid: 7 }) + "\n" + status(6000) + "\n");
    expect(tail.read().map((l) => l.msg)).toEqual(["market maker started", "status", "fill", "market maker started", "status"]);
  });

  it("starts over when the file is replaced by a shorter one, and copes with a missing file", () => {
    const f = tmp();
    const tail = new LogTail(f);
    expect(tail.read()).toEqual([]);
    writeFileSync(f, START + "\n" + status(1000) + "\n" + status(2000) + "\n");
    expect(tail.read()).toHaveLength(3);
    writeFileSync(f, line(0, "info", "market maker started", { pid: 9 }) + "\n");
    expect(tail.read()).toHaveLength(1);
  });

  it("LiveFile returns the last good snapshot while the file is being replaced", () => {
    const f = tmp();
    const lf = new LiveFile(f);
    expect(lf.read()).toBeNull();
    writeFileSync(f, JSON.stringify({ t: iso(0), pid: 1 }));
    expect(lf.read()).toMatchObject({ pid: 1 });
    writeFileSync(f, '{"t":"broken'); // torn write
    expect(lf.read()).toMatchObject({ pid: 1 });
  });
});

describe("engine live snapshot with two markets", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes a per-market snapshot every second and quotes both markets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-live-"));
    dirs.push(dir);
    const names = ["BTC/USD", "ETH/USD"];
    const cfg = configSchema.parse({
      markets: names.map((n) => ({ name: n, maxPositionUsd: 500, levelSizeUsd: 100 })),
      paper: { seed: 11, flowPerSec: 4 },
      engine: { liveFile: join(dir, "live.json"), stateFile: join(dir, "state.json"), pointsLogFile: join(dir, "p.csv"), statusEveryMs: 30_000 },
    });
    const ex = new PaperExchange(cfg.paper, names);
    const specs = await ex.init(names);
    const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
    const mm = new MarketMaker(cfg, ex, specs, { persist: true, log: (_l, msg, extra) => logs.push({ msg, extra }) });
    const t0 = Date.UTC(2026, 0, 1);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const now = t0 + i * cfg.engine.tickMs;
      ex.advance(now);
      await mm.step(now);
      if (i > 0 && i % 4 === 0) {
        const snap = JSON.parse(readFileSync(cfg.engine.liveFile, "utf8")) as Record<string, unknown>;
        seen.add(String(snap.t));
      }
    }
    const snap = JSON.parse(readFileSync(cfg.engine.liveFile, "utf8")) as Record<string, any>;
    expect(snap.pid).toBe(process.pid);
    expect(Object.keys(snap.markets).sort()).toEqual(names);
    for (const n of names) {
      expect(snap.markets[n].mid).toBeGreaterThan(0);
      expect(snap.markets[n].bid).toBeLessThan(snap.markets[n].ask);
      expect(snap.markets[n].quoting).toBe(true);
      expect(snap.markets[n].quotes.bids.length).toBeGreaterThan(0);
      expect(snap.markets[n].fuse).toBe("ok");
    }
    expect(snap.equity).toBeGreaterThan(0);
    expect(snap.positionsUsd).toBeDefined();
    // 400 ticks of 250 ms = 100 s of simulated time -> about one snapshot per second.
    expect(logs.filter((l) => l.msg === "status").length).toBeGreaterThanOrEqual(3);
    expect(seen.size).toBeGreaterThan(0);

    // And the dashboard can read what the engine wrote, as the same shape it reads from the log.
    const status = logs.filter((l) => l.msg === "status").pop()!.extra!;
    const d = analyze(
      [
        { t: new Date(t0).toISOString(), ts: t0, level: "info", msg: "market maker started", pid: process.pid, markets: names },
        { t: new Date(t0 + 99_000).toISOString(), ts: t0 + 99_000, level: "info", msg: "status", ...status },
      ],
      { now: Date.parse(snap.t as string) + 500, staleMs: 120_000, aptUsd: 1, killFile: false, live: snap },
    );
    expect(d.markets.map((m) => m.name)).toEqual(names);
    expect(d.run.state).toBe("running");
  });
});
