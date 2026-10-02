import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config.js";

/**
 * Start / End buttons for the dashboard. Everything here is opt-in (`dashboard --control`) because it lets a
 * web page start a live trading process, so:
 *
 * - every request must carry the secret from `tokenFile` (a custom header a foreign web page cannot send, and a
 *   value it cannot know), and repeated wrong guesses lock the endpoint for a while;
 * - the bot is started by running the same command an operator would type, with the keys read from an env file
 *   by the child shell, so the dashboard process never holds the private key itself;
 * - the child is detached: restarting the dashboard never stops the bot;
 * - ending a run is a file (`stopFile`) the bot polls, not a signal, so it also works for a bot that was started
 *   by hand, and it never kills anything. The bot closes every position itself before it exits.
 */

export interface ControlOpts {
  /** Config the started bot uses. */
  configPath: string;
  /** Shell-sourceable file with APTOS_NODE_API_KEY, MM_PRIVATE_KEY, MM_SUBACCOUNT, MM_OWNER. */
  envFile: string;
  cwd: string;
  tokenFile: string;
  pidFile: string;
  /** Where the started bot's stdout/stderr go. */
  stdoutFile: string;
  /** Test hooks. */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number; unref(): void };
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** How long to watch a freshly started bot for an immediate crash. */
  settleMs?: number;
}

export interface ControlPaths {
  stopFile: string;
  killFile: string;
}

export type ControlResult = { ok: true; [k: string]: unknown } | { ok: false; code: number; error: string; detail?: string };

interface PidInfo {
  pid: number;
  startedAt: number;
  minutes: number;
  dryRun: boolean;
  endsAt: number;
}

export const MAX_MINUTES = 10_080;

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("cli.ts"); // guards against a recycled pid
  } catch {
    return true; // no /proc (not Linux): trust the signal probe
  }
}

export class BotControl {
  private readonly token: string;
  private failures = 0;
  private lockedUntil = 0;
  private configCache: { key: string; value: unknown } | null = null;

  constructor(
    private readonly o: ControlOpts,
    private readonly paths: ControlPaths,
  ) {
    this.token = loadOrCreateToken(o.tokenFile);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Constant-time check of the request token, with a lock-out after repeated failures. */
  authorize(given: string | undefined): { ok: true } | { ok: false; code: number; error: string } {
    if (this.now() < this.lockedUntil) return { ok: false, code: 429, error: "Sai mã quá nhiều lần, thử lại sau ít phút." };
    const a = Buffer.from(given ?? "");
    const b = Buffer.from(this.token);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.failures = 0;
      return { ok: true };
    }
    if (++this.failures >= 5) {
      this.lockedUntil = this.now() + 60_000;
      this.failures = 0;
    }
    return { ok: false, code: 401, error: "Mã điều khiển không đúng. Xem file state/dashboard.token trên máy chạy dashboard." };
  }

  private readPid(): PidInfo | null {
    try {
      const j = JSON.parse(readFileSync(this.o.pidFile, "utf8")) as Partial<PidInfo>;
      return typeof j.pid === "number" ? (j as PidInfo) : null;
    } catch {
      return null;
    }
  }

  private summary(): unknown {
    try {
      const key = `${this.o.configPath}:${statSync(this.o.configPath).mtimeMs}`;
      if (this.configCache?.key !== key) {
        const c = loadConfig(this.o.configPath);
        this.configCache = {
          key,
          value: {
            network: c.network,
            markets: c.markets.map((m) => ({ name: m.name, maxPositionUsd: m.maxPositionUsd, levelSizeUsd: m.levelSizeUsd })),
            minReplaceIntervalMs: c.engine.minReplaceIntervalMs,
            maxDrawdownUsd: c.risk.maxDrawdownUsd,
          },
        };
      }
      return this.configCache.value;
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e).slice(0, 300) };
    }
  }

  /** What the page needs to draw the panel. `live` is the parsed live.json, if any. */
  status(live: Record<string, unknown> | null): Record<string, unknown> {
    const alive = this.o.isAlive ?? defaultAlive;
    const info = this.readPid();
    const pidAlive = info !== null && alive(info.pid);
    const liveT = typeof live?.t === "string" ? Date.parse(live.t) : NaN;
    const liveFresh = Number.isFinite(liveT) && this.now() - liveT < 10_000;
    const running = pidAlive || liveFresh;
    const liveEnds = typeof live?.endsAt === "number" ? live.endsAt : null;
    return {
      enabled: true,
      running,
      startedBy: pidAlive ? "dashboard" : liveFresh ? "external" : null,
      pid: pidAlive ? info!.pid : liveFresh && typeof live?.pid === "number" ? live.pid : null,
      endsAt: pidAlive && info!.endsAt ? info!.endsAt : liveEnds,
      stopRequested: existsSync(this.paths.stopFile),
      killFile: existsSync(this.paths.killFile),
      envFileOk: existsSync(resolve(this.o.cwd, this.o.envFile)),
      maxMinutes: MAX_MINUTES,
      config: this.summary(),
    };
  }

  async start(body: unknown, live: Record<string, unknown> | null): Promise<ControlResult> {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const minutes = Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
      return { ok: false, code: 400, error: `Thời gian chạy phải từ 1 đến ${MAX_MINUTES} phút.` };
    }
    const dryRun = b.dryRun === true;
    if (this.status(live).running) return { ok: false, code: 409, error: "Bot đang chạy. Kết thúc phiên hiện tại trước khi bắt đầu phiên mới." };
    if (existsSync(this.paths.killFile)) return { ok: false, code: 409, error: `File ${this.paths.killFile} đang tồn tại (khóa khẩn cấp). Xóa nó rồi thử lại.` };
    if (!existsSync(resolve(this.o.cwd, this.o.envFile))) return { ok: false, code: 400, error: `Không thấy file khóa ${this.o.envFile}. Chạy dashboard với --env-file đúng đường dẫn.` };
    const cfg = this.summary() as { error?: string };
    if (cfg.error) return { ok: false, code: 400, error: `Cấu hình không hợp lệ: ${cfg.error}` };

    try {
      unlinkSync(this.paths.stopFile); // a leftover STOP must not end the new run at once
    } catch {
      /* none */
    }
    mkdirSync(dirname(this.o.stdoutFile), { recursive: true });
    const out = openSync(this.o.stdoutFile, "a");
    // Absolute on purpose: bash's `.` looks a bare name such as "env" up in PATH first and would source /usr/bin/env.
    const envAbs = resolve(this.o.cwd, this.o.envFile);
    const args = ["-c", 'set -a; . "$1"; set +a; shift; exec "$@"', "mm-dashboard", envAbs, process.execPath, "--import", "tsx", "src/cli.ts", "live", this.o.configPath, "--minutes", String(Math.round(minutes))];
    if (dryRun) args.push("--dry-run");
    const spawnFn = this.o.spawnFn ?? ((c: string, a: string[], p: SpawnOptions) => spawn(c, a, p));
    let child: { pid?: number; unref(): void };
    try {
      child = spawnFn("bash", args, { cwd: this.o.cwd, detached: true, stdio: ["ignore", out, out], env: process.env });
    } finally {
      closeSync(out);
    }
    child.unref();
    if (!child.pid) return { ok: false, code: 500, error: "Không khởi động được tiến trình bot." };
    const startedAt = this.now();
    const info: PidInfo = { pid: child.pid, startedAt, minutes: Math.round(minutes), dryRun, endsAt: startedAt + Math.round(minutes) * 60_000 };
    mkdirSync(dirname(this.o.pidFile), { recursive: true });
    writeFileSync(this.o.pidFile, JSON.stringify(info));

    await new Promise((r) => setTimeout(r, this.o.settleMs ?? 2500));
    if (!(this.o.isAlive ?? defaultAlive)(child.pid)) {
      let tail = "";
      try {
        tail = readFileSync(this.o.stdoutFile, "utf8").trim().split("\n").slice(-6).join("\n").slice(-900);
      } catch {
        /* no output */
      }
      return { ok: false, code: 500, error: "Bot thoát ngay sau khi khởi động.", detail: tail };
    }
    return { ok: true, pid: child.pid, endsAt: info.endsAt, dryRun };
  }

  /** Ask the running bot to end: it pulls quotes, closes every position and exits. */
  stop(live: Record<string, unknown> | null): ControlResult {
    if (!this.status(live).running) return { ok: false, code: 409, error: "Không thấy bot đang chạy." };
    mkdirSync(dirname(this.paths.stopFile), { recursive: true });
    writeFileSync(this.paths.stopFile, new Date(this.now()).toISOString());
    return { ok: true };
  }
}

function loadOrCreateToken(file: string): string {
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return token;
}
