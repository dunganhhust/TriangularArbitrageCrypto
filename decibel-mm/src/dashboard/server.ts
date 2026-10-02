import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
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
  /** Without a live snapshot a run is "stale" after this long with no log line. */
  staleMs?: number;
  /** How much of the log's tail is read on first load (later reads are incremental). */
  tailBytes?: number;
  /** APT price used when neither a manual override nor the live feed is available. */
  defaultAptUsd?: number;
  /** Live APT price source. Pass null to disable (tests); omitted = public exchange endpoints. */
  priceFeed?: PriceFeed | null;
}

const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));

/** Window lengths the page offers, in seconds; anything else is ignored. */
const MAX_RANGE_SEC = 7 * 86_400;

export function startDashboard(o: DashboardOpts): Promise<Server> {
  const staleMs = o.staleMs ?? 120_000;
  const tail = new LogTail(o.logFile, o.tailBytes ?? 24_000_000);
  const liveFile = new LiveFile(o.liveFile ?? "");
  const feed = o.priceFeed === undefined ? new PriceFeed() : o.priceFeed;
  feed?.start();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, type: string, body: string): void => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    if (req.method !== "GET") return send(405, "text/plain", "method not allowed");
    try {
      if (url.pathname === "/") return send(200, "text/html; charset=utf-8", readFileSync(PAGE, "utf8"));
      if (url.pathname === "/healthz") return send(200, "text/plain", "ok");
      if (url.pathname === "/favicon.ico") return send(204, "image/x-icon", "");
      if (url.pathname === "/api/data") {
        const q = url.searchParams;
        const manual = Number(q.get("apt"));
        const px = feed?.get() ?? null;
        const aptUsd = Number.isFinite(manual) && manual > 0 ? manual : px && px.ageSec <= 120 ? px.usd : (o.defaultAptUsd ?? 0.8);
        const rangeSec = Number(q.get("range"));
        const rangeMs = Number.isFinite(rangeSec) && rangeSec > 0 && rangeSec <= MAX_RANGE_SEC ? Math.round(rangeSec * 1000) : null;
        const market = q.get("market") || null;
        const data = analyze(tail.read(), {
          now: Date.now(),
          staleMs,
          aptUsd,
          killFile: existsSync(o.killFile),
          rangeMs,
          market,
          live: liveFile.read(),
        });
        data.aptPrice = px;
        return send(200, "application/json", JSON.stringify(data));
      }
      return send(404, "text/plain", "not found");
    } catch (e) {
      return send(500, "application/json", JSON.stringify({ error: String(e) }));
    }
  });
  server.on("close", () => feed?.stop());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve(server));
  });
}
