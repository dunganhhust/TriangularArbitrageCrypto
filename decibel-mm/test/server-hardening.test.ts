import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_VERSION, startDashboard } from "../src/dashboard/server.js";
import type { Server } from "node:http";

let dir: string;
let servers: Server[];
const T = Date.now();
const line = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ t: new Date(T + ms).toISOString(), level, msg, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mm-srv-"));
  mkdirSync(join(dir, "data"));
  servers = [];
  const rows = [line(-3600_000, "info", "market maker started", { markets: ["ETH/USD"], network: "mainnet", dryRun: false, pid: 1 })];
  for (let i = 0; i < 400; i++) {
    rows.push(line(-3600_000 + i * 8000, "info", "status", { equity: 20, startEquity: 20, positionsUsd: { "ETH/USD": 3 }, mids: { "ETH/USD": 2700 }, gasApt: i / 1e4, txCount: i }));
    rows.push(line(-3600_000 + i * 8000 + 100, "info", "fill", { market: "ETH/USD", side: "buy", px: 2700, sz: 0.004, maker: true, fee: 0.0016 }));
  }
  writeFileSync(join(dir, "data", "run.log"), rows.join("\n") + "\n");
});
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  rmSync(dir, { recursive: true, force: true });
});

async function up(extra: Record<string, unknown> = {}) {
  const s = await startDashboard({ port: 0, logFile: join(dir, "data", "run.log"), killFile: join(dir, "KILL"), priceFeed: null, ...extra });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("/api/data", () => {
  it("is gzip-compressed for a browser, identical once decompressed, and much smaller", async () => {
    const base = await up({ cacheMs: 0 });
    const plain = await fetch(`${base}/api/data?range=3600`, { headers: { "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    const plainText = await plain.text();
    // node's fetch decompresses transparently; ask for the raw bytes with the http module
    const raw = await new Promise<{ enc: string | undefined; body: Buffer }>((resolve, reject) => {
      import("node:http").then(({ get }) => {
        get(`${base}/api/data?range=3600`, { headers: { "accept-encoding": "gzip" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ enc: res.headers["content-encoding"] as string | undefined, body: Buffer.concat(chunks) }));
        }).on("error", reject);
      });
    });
    expect(raw.enc).toBe("gzip");
    expect(raw.body.length).toBeLessThan(plainText.length / 3);
    const a = JSON.parse(gunzipSync(raw.body).toString("utf8"));
    const b = JSON.parse(plainText);
    expect(a.fills.total).toBe(b.fills.total);
    expect(a.api).toBe(API_VERSION);
  });

  it("reuses an answer for the cache time, and a fresh one is computed once it is over or the cache is off", async () => {
    const base = await up({ cacheMs: 60_000 });
    const first = await (await fetch(`${base}/api/data`)).text();
    appendFileSync(join(dir, "data", "run.log"), line(1000, "info", "fill", { market: "ETH/USD", side: "sell", px: 2700, sz: 0.004, maker: true, fee: 0.0016 }) + "\n");
    expect(await (await fetch(`${base}/api/data`)).text()).toBe(first); // cached
    const other = await up({ cacheMs: 0 });
    const a = await (await fetch(`${other}/api/data`)).json();
    appendFileSync(join(dir, "data", "run.log"), line(2000, "info", "fill", { market: "ETH/USD", side: "sell", px: 2700, sz: 0.004, maker: true, fee: 0.0016 }) + "\n");
    const b = await (await fetch(`${other}/api/data`)).json();
    expect(b.logLines).toBeGreaterThan(a.logLines);
  });

  it("different queries do not share an answer", async () => {
    const base = await up({ cacheMs: 60_000 });
    const all = await (await fetch(`${base}/api/data`)).json();
    const hour = await (await fetch(`${base}/api/data?range=300`)).json();
    expect(hour.window.ms).toBe(300_000);
    expect(all.window.ms).toBeNull();
  });

  it("carries the API version, the build id of the page it serves and the server's own identity", async () => {
    const base = await up();
    const d = await (await fetch(`${base}/api/data`)).json();
    const html = await (await fetch(`${base}/`)).text();
    expect(d.api).toBe(API_VERSION);
    expect(d.build).toMatch(/^[0-9a-f]{10}$/);
    expect(html).toContain(`name="mm-build" content="${d.build}"`); // the page knows which build it is
    expect(html).not.toContain("__BUILD__");
    expect(html).not.toContain("__API__");
    expect(html).toContain(`Number("${API_VERSION}")`);
    expect(d.server).toMatchObject({ pid: process.pid });
    expect(d.server.rssMb).toBeGreaterThan(0);
  });

  it("ladder rows no longer carry the order book (the page never shows it) and the payload is modest", async () => {
    const rows = [line(-1000, "info", "ladder placed", { market: "ETH/USD", hash: "0xabc", gasUsed: "270", quotes: { bids: [[2699, 0.004]], asks: [[2701, 0.004]] } })];
    appendFileSync(join(dir, "data", "run.log"), rows.join("\n") + "\n");
    const base = await up();
    const d = await (await fetch(`${base}/api/data`)).json();
    expect(d.ladders.recent.length).toBeGreaterThan(0);
    expect(d.ladders.recent[0]).not.toHaveProperty("quotes");
    expect(d.markets[0].quotes).toEqual({ bids: [[2699, 0.004]], asks: [[2701, 0.004]] }); // the latest ladder is still shown
  });
});

describe("/healthz", () => {
  it("is a bare ok for the service manager, and a detailed report with ?deep=1", async () => {
    const base = await up();
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    const d = await (await fetch(`${base}/healthz?deep=1`)).json();
    expect(d).toMatchObject({ ok: true, api: API_VERSION, pid: process.pid, control: false });
    expect(d.log).toMatchObject({ exists: true });
    expect(d.log.lines).toBeGreaterThan(100);
    expect(d.log.lastLineAgeSec).toBeGreaterThanOrEqual(0);
    expect(d.rssMb).toBeGreaterThan(0);
    expect(d.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("still answers when there is no log at all", async () => {
    rmSync(join(dir, "data", "run.log"));
    const base = await up();
    const d = await (await fetch(`${base}/healthz?deep=1`)).json();
    expect(d.ok).toBe(true);
    expect(d.log.exists).toBe(false);
    expect(d.log.lastLineAgeSec).toBeNull();
  });
});

describe("restart guard", () => {
  it("calls onTrip after the configured number of checks above the memory limit, and not below it", async () => {
    const trips: string[] = [];
    await up({ guard: { maxRssMb: 1, strikes: 2, everyMs: 20, onTrip: (why: string) => trips.push(why) } });
    await new Promise((r) => setTimeout(r, 150));
    expect(trips.length).toBeGreaterThan(0);
    expect(trips[0]).toContain("above 1 MB");

    const quiet: string[] = [];
    const base = await up({ guard: { maxRssMb: 100_000, strikes: 1, everyMs: 20, onTrip: (why: string) => quiet.push(why) } });
    await new Promise((r) => setTimeout(r, 120));
    expect(quiet).toEqual([]);
    expect((await fetch(`${base}/healthz`)).ok).toBe(true);
  });
});

describe("startup", () => {
  it("fails with the address-in-use error when the port is taken, so the service manager retries", async () => {
    const base = await up();
    const port = Number(new URL(base).port);
    await expect(startDashboard({ port, logFile: join(dir, "data", "run.log"), killFile: join(dir, "KILL"), priceFeed: null })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
