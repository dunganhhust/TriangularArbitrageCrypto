import { createServer } from "node:http";
import type { Server } from "node:http";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze, parseLog } from "./analyze.js";
import type { LogLine } from "./analyze.js";

export interface DashboardOpts {
  port: number;
  /** Always bound to the loopback interface: the page has no login. Reach it through an SSH tunnel. */
  host?: string;
  logFile: string;
  killFile: string;
  staleMs?: number;
  /** Largest tail of the log that is parsed (a long run's log is much bigger than the page needs). */
  tailBytes?: number;
  defaultAptUsd?: number;
}

const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));

/** Last `maxBytes` of a file, starting at a line boundary. */
export function readTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function startDashboard(o: DashboardOpts): Promise<Server> {
  const staleMs = o.staleMs ?? 120_000;
  const tail = o.tailBytes ?? 4_000_000;
  let cache: { key: string; lines: LogLine[] } | null = null;

  const load = (): LogLine[] => {
    if (!existsSync(o.logFile)) return [];
    const s = statSync(o.logFile);
    const key = `${s.size}:${s.mtimeMs}`;
    if (cache?.key !== key) cache = { key, lines: parseLog(readTail(o.logFile, tail)) };
    return cache.lines;
  };

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
        const apt = Number(url.searchParams.get("apt"));
        const aptUsd = Number.isFinite(apt) && apt > 0 ? apt : (o.defaultAptUsd ?? 0.8);
        const data = analyze(load(), { now: Date.now(), staleMs, aptUsd, killFile: existsSync(o.killFile) });
        return send(200, "application/json", JSON.stringify(data));
      }
      return send(404, "text/plain", "not found");
    } catch (e) {
      return send(500, "application/json", JSON.stringify({ error: String(e) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve(server));
  });
}
