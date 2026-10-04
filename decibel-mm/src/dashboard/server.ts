import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { analyze } from "./analyze.js";
import { BotControl } from "./control.js";
import type { ControlOpts } from "./control.js";
import { PriceFeed } from "./price.js";
import { LiveFile, LogTail } from "./tail.js";

export interface DashboardOpts {
  port: number;
  /** Always bound to the loopback interface: the page has no login. Reach it through an SSH tunnel. */
  host?: string;
  logFile: string;
  /** live.json written by the bot every second; "" = not used. */
  liveFile?: string;
  killFile: string;
  /** Creating this file asks the bot to end the run and close every position. */
  stopFile?: string;
  /** Status snapshot written by the 24/7 supervisor; "" or omitted = none. */
  supervisorFile?: string;
  /** Start / End buttons. null or omitted = the page is strictly read-only. */
  control?: Omit<ControlOpts, "spawnFn" | "isAlive" | "now" | "settleMs"> & Partial<Pick<ControlOpts, "spawnFn" | "isAlive" | "now" | "settleMs">> | null;
  /** Without a live snapshot a run is "stale" after this long with no log line. */
  staleMs?: number;
  /** How much of the log's tail is read on first load (later reads are incremental). */
  tailBytes?: number;
  /** APT price used when neither a manual override nor the live feed is available. */
  defaultAptUsd?: number;
  /** Live APT price source. Pass null to disable (tests); omitted = public exchange endpoints. */
  priceFeed?: PriceFeed | null;
  /** How long an answer to /api/data is reused (all open tabs share it). Default 700 ms; 0 turns the cache off. */
  cacheMs?: number;
  /**
   * Restart protection for a long-lived process: when the resident memory stays above `maxRssMb` for `strikes` checks 10 s
   * apart, `onTrip` is called (the CLI exits so that the service manager starts a fresh process). Off when omitted.
   */
  guard?: { maxRssMb: number; strikes?: number; everyMs?: number; onTrip: (why: string) => void };
}

/**
 * Version of the shape of /api/data. The page asks for the number it was written for; when the running server reports a
 * different one (the code was updated but the service not restarted, or the other way round) the page says so plainly
 * instead of failing in some random place.
 */
export const API_VERSION = 4;

const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));

/** The page, read again whenever the file changes, with its build id (a hash of the file and the API version) filled in. */
class Page {
  private mtime = -1;
  private html = "";
  build = "";

  get(): string {
    const m = statSync(PAGE).mtimeMs;
    if (m !== this.mtime) {
      const raw = readFileSync(PAGE, "utf8");
      this.build = createHash("sha1").update(raw).update(String(API_VERSION)).digest("hex").slice(0, 10);
      this.html = raw.replaceAll("__BUILD__", this.build).replaceAll("__API__", String(API_VERSION));
      this.mtime = m;
    }
    return this.html;
  }
}

interface Cached {
  at: number;
  json: string;
  gz: Buffer | null;
}

/** Window lengths the page offers, in seconds; anything else is ignored. */
const MAX_RANGE_SEC = 7 * 86_400;

export function startDashboard(o: DashboardOpts): Promise<Server> {
  const staleMs = o.staleMs ?? 120_000;
  const tail = new LogTail(o.logFile, o.tailBytes ?? 24_000_000, undefined, { keepLines: false });
  const liveFile = new LiveFile(o.liveFile ?? "");
  const feed = o.priceFeed === undefined ? new PriceFeed() : o.priceFeed;
  feed?.start();
  const control = o.control ? new BotControl(o.control, { stopFile: o.stopFile ?? "state/STOP", killFile: o.killFile }) : null;
  const page = new Page();
  const cacheMs = o.cacheMs ?? 700;
  const cache = new Map<string, Cached>();
  const startedAt = Date.now();
  // Event-loop delay and memory, for /healthz?deep=1 and the restart guard.
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let loopP99Ms = 0;
  const sampler = setInterval(() => {
    loopP99Ms = loop.percentile(99) / 1e6;
    loop.reset();
  }, 10_000);
  sampler.unref();
  let strikes = 0;
  const watch = o.guard
    ? setInterval(() => {
        const rssMb = process.memoryUsage().rss / 1e6;
        strikes = rssMb > o.guard!.maxRssMb ? strikes + 1 : 0;
        if (strikes >= (o.guard!.strikes ?? 3)) o.guard!.onTrip(`resident memory ${Math.round(rssMb)} MB above ${o.guard!.maxRssMb} MB for ${strikes} checks`);
      }, o.guard.everyMs ?? 10_000)
    : null;
  watch?.unref();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, type: string, body: string): void => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    res.on("error", () => {}); // a client that vanished mid-answer is not an error of ours
    if (req.method === "POST" && url.pathname.startsWith("/api/control/")) {
      if (!control) return send(404, "application/json", JSON.stringify({ ok: false, error: "Điều khiển đang tắt: chạy dashboard với --control." }));
      const auth = control.authorize(typeof req.headers["x-mm-token"] === "string" ? req.headers["x-mm-token"] : undefined);
      if (!auth.ok) return send(auth.code, "application/json", JSON.stringify(auth));
      let raw = "";
      let tooBig = false;
      req.on("data", (c: Buffer) => {
        raw += c.toString("utf8");
        if (raw.length > 4096) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        void (async () => {
          try {
            let body: unknown = {};
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              return send(400, "application/json", JSON.stringify({ ok: false, error: "Nội dung không phải JSON." }));
            }
            const live = liveFile.read();
            const r = url.pathname === "/api/control/start" ? await control.start(body, live) : url.pathname === "/api/control/stop" ? control.stop(live) : null;
            cache.clear(); // the next poll must show the new state, not a second-old answer
            if (!r) return send(404, "application/json", JSON.stringify({ ok: false, error: "not found" }));
            return send(r.ok ? 200 : r.code, "application/json", JSON.stringify(r));
          } catch (e) {
            return send(500, "application/json", JSON.stringify({ ok: false, error: String(e) }));
          }
        })();
      });
      return;
    }
    if (req.method !== "GET") return send(405, "text/plain", "method not allowed");
    try {
      if (url.pathname === "/") return send(200, "text/html; charset=utf-8", page.get());
      if (url.pathname === "/healthz") {
        if (url.searchParams.get("deep") !== "1") return send(200, "text/plain", "ok");
        const mem = process.memoryUsage();
        const idx = tail.readIndex();
        const last = idx.all.at(-1)?.lastLine?.ts ?? null;
        const live = liveFile.read();
        const liveTs = typeof live?.t === "string" ? Date.parse(live.t) : NaN;
        const px = feed?.get() ?? null;
        page.get();
        return send(
          200,
          "application/json",
          JSON.stringify({
            ok: true,
            api: API_VERSION,
            build: page.build,
            pid: process.pid,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            rssMb: Math.round(mem.rss / 1e6),
            heapMb: Math.round(mem.heapUsed / 1e6),
            loopP99Ms: Math.round(loopP99Ms * 10) / 10,
            log: { exists: existsSync(o.logFile), lines: idx.total, retained: idx.retained, runs: idx.all.length, lastLineAgeSec: last === null ? null : Math.round((Date.now() - last) / 1000) },
            live: { seen: Number.isFinite(liveTs), ageSec: Number.isFinite(liveTs) ? Math.round((Date.now() - liveTs) / 1000) : null },
            aptPrice: px ? { usd: px.usd, source: px.source, ageSec: px.ageSec } : null,
            control: control !== null,
          }),
        );
      }
      if (url.pathname === "/favicon.ico") return send(204, "image/x-icon", "");
      if (url.pathname === "/api/data") {
        const key = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
        const now = Date.now();
        let hit = cacheMs > 0 ? cache.get(key) : undefined;
        if (!hit || now - hit.at >= cacheMs) {
          hit = { at: now, json: JSON.stringify(compute(url.searchParams)), gz: null };
          if (cacheMs > 0) {
            cache.set(key, hit);
            if (cache.size > 16) cache.delete(cache.keys().next().value as string); // oldest first
          }
        }
        const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
        const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", vary: "accept-encoding" };
        if (wantsGzip && hit.json.length > 1024) {
          hit.gz ??= gzipSync(hit.json, { level: 4 });
          res.writeHead(200, { ...headers, "content-encoding": "gzip" });
          return void res.end(hit.gz);
        }
        res.writeHead(200, headers);
        return void res.end(hit.json);
      }
      return send(404, "text/plain", "not found");
    } catch (e) {
      return send(500, "application/json", JSON.stringify({ error: String(e) }));
    }
  });
  server.on("close", () => {
    feed?.stop();
    clearInterval(sampler);
    if (watch) clearInterval(watch);
    loop.disable();
  });
  // A request that never finishes (a stuck proxy, a half-open tunnel) must not hold a socket for ever.
  server.requestTimeout = 20_000;
  server.headersTimeout = 15_000;

  /** One /api/data answer, as an object. */
  function compute(q: URLSearchParams): ReturnType<typeof analyze> {
    const manual = Number(q.get("apt"));
    const px = feed?.get() ?? null;
    const aptUsd = Number.isFinite(manual) && manual > 0 ? manual : px && px.ageSec <= 120 ? px.usd : (o.defaultAptUsd ?? 0.8);
    const rangeSec = Number(q.get("range"));
    const rangeMs = Number.isFinite(rangeSec) && rangeSec > 0 && rangeSec <= MAX_RANGE_SEC ? Math.round(rangeSec * 1000) : null;
    const market = q.get("market") || null;
    const runId = Number(q.get("run"));
    const runStart = Number.isFinite(runId) && runId > 0 ? runId : null;
    const live = liveFile.read();
    const data = analyze(tail.readIndex(), {
      now: Date.now(),
      staleMs,
      aptUsd,
      killFile: existsSync(o.killFile),
      rangeMs,
      market,
      runStart,
      live,
    });
    data.aptPrice = px;
    data.control = control ? control.status(live) : { enabled: false };
    data.supervisor = readSupervisor(o.supervisorFile ?? "");
    page.get();
    return Object.assign(data, { api: API_VERSION, build: page.build, server: { pid: process.pid, startedAt, rssMb: Math.round(process.memoryUsage().rss / 1e6) } });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve(server));
  });
}

let supCache: { file: string; mtime: number; value: Record<string, unknown> | null } | null = null;

/** The supervisor's status file, with `alive` saying whether its process still exists. null when there is none. */
function readSupervisor(file: string): Record<string, unknown> | null {
  if (!file) return null;
  try {
    const mtime = statSync(file).mtimeMs;
    if (!supCache || supCache.file !== file || supCache.mtime !== mtime) {
      supCache = { file, mtime, value: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> };
    }
    const v = supCache.value;
    if (!v) return null;
    let alive = false;
    try {
      process.kill(Number(v.pid), 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    return { ...v, alive };
  } catch {
    return null;
  }
}
