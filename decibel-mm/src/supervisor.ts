import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./engine.js";

/**
 * Keeps the trading process alive for unattended (24/7) runs.
 *
 * It starts `live`, and when that process dies for a reason that a fresh process can fix (a crash, the watchdog asking
 * for a restart, a network failure at start-up) it starts another one after a growing pause. It never restarts after
 * an outcome that needs a person:
 *
 *   exit 0  the run ended on purpose (End button / STOP file / signal)      -> stop, 0
 *   exit 2  the bot halted itself (loss limit, kill switch, gas, fuses)     -> stop, 2
 *   exit 3  the run ended but a position could not be closed                -> stop, 3
 *   other   crash, exit 70 (uncaught error), exit 75 (watchdog), signal     -> restart
 *
 * and when it has had to start too many processes within an hour (a broken configuration, an outage) it cancels the
 * quotes and slows down to the allowed rate instead of stopping: an unattended run with open positions is better served
 * by a process that keeps trying at a polite pace than by one that gives up after twenty minutes of API trouble.
 */

export interface ChildExit {
  code: number | null;
  signal: string | null;
}

export interface Child {
  pid: number | undefined;
  exited: Promise<ChildExit>;
  /** Ask the process to stop (SIGTERM = pull quotes and exit). */
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type SupervisorState = "starting" | "running" | "backoff" | "throttled" | "stopping" | "stopped";

export interface SupervisorStatus {
  pid: number;
  state: SupervisorState;
  startedAt: number;
  /** Processes started so far, the first included. */
  starts: number;
  restarts: number;
  childPid: number | null;
  childStartedAt: number | null;
  lastExit: { code: number | null; signal: string | null; at: number; ranMs: number } | null;
  /** When the next process will be started, while backing off. */
  nextStartAt: number | null;
  /** Epoch ms at which the supervised run must end, or null for a run without end. */
  endsAt: number | null;
  detail: string | null;
}

export interface SuperviseOpts {
  /** Start one process running the given subcommand (`live`, `flatten`, `cancel`) with extra arguments. */
  spawn(command: "live" | "flatten" | "cancel", args: string[], attempt: number): Child;
  stopFile: string;
  killFile: string;
  /** Where the status snapshot is written (atomically); "" = not written. */
  statusFile: string;
  log: Logger;
  /** Epoch ms at which the run must end; null = run until stopped. */
  endsAt?: number | null;
  /** Extra arguments for every `live` process (e.g. --dry-run). */
  liveArgs?: string[];
  /** Extra arguments for the one-off `flatten` / `cancel` commands (e.g. --dry-run, so a dry run never sends real orders). */
  helperArgs?: string[];
  /** Pauses before successive restarts; the last one repeats. */
  backoffMs?: number[];
  /** A process that ran at least this long counts as healthy and resets the backoff. */
  healthyMs?: number;
  /** Slow down (one start per hour slot) once this many processes were started within the last hour. */
  maxStartsPerHour?: number;
  /** How long a stopping child may take before it is killed. */
  stopGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void;
  pid?: number;
}

const HOUR = 3_600_000;

export class Supervisor {
  private stopping = false;
  private signalStop: () => void = () => {};
  /** Resolves when a stop is requested. */
  private readonly stopSignal = new Promise<void>((r) => {
    this.signalStop = r;
  });
  private child: Child | null = null;
  private childKind: "live" | "flatten" | "cancel" | null = null;
  private status: SupervisorStatus;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exists: (p: string) => boolean;
  private readonly remove: (p: string) => void;
  private readonly backoff: number[];
  private readonly healthyMs: number;
  private readonly maxStarts: number;
  private readonly grace: number;

  constructor(private readonly o: SuperviseOpts) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.exists = o.exists ?? existsSync;
    this.remove =
      o.remove ??
      ((p) => {
        try {
          unlinkSync(p);
        } catch {
          /* already gone */
        }
      });
    this.backoff = o.backoffMs && o.backoffMs.length > 0 ? o.backoffMs : [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
    this.healthyMs = o.healthyMs ?? 600_000;
    this.maxStarts = o.maxStartsPerHour ?? 8;
    this.grace = o.stopGraceMs ?? 60_000;
    this.status = {
      pid: o.pid ?? process.pid,
      state: "starting",
      startedAt: this.now(),
      starts: 0,
      restarts: 0,
      childPid: null,
      childStartedAt: null,
      lastExit: null,
      nextStartAt: null,
      endsAt: o.endsAt ?? null,
      detail: null,
    };
  }

  /** A termination signal reached the supervisor: stop restarting, pass it on, wait for the child. */
  requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.set({ state: "stopping", detail: "signal received" });
    this.signalStop();
    // `live` turns SIGTERM into "pull the quotes, keep the positions". A one-off flatten/cancel is already doing what a
    // stop would want and must be allowed to finish (it is killed after the grace period if it hangs).
    if (this.childKind === "live") this.child?.kill("SIGTERM");
  }

  snapshot(): SupervisorStatus {
    return { ...this.status };
  }

  private set(patch: Partial<SupervisorStatus>): void {
    this.status = { ...this.status, ...patch };
    const f = this.o.statusFile;
    if (!f) return;
    try {
      mkdirSync(dirname(f), { recursive: true });
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...this.status, t: new Date(this.now()).toISOString() }));
      renameSync(tmp, f);
    } catch {
      /* the status file is for display only */
    }
  }

  /** Wait for a child, killing it if it will not stop within the grace period once we are stopping. */
  private async waitFor(child: Child): Promise<ChildExit> {
    let finished = false;
    const late = this.stopSignal.then(async () => {
      await this.sleep(this.grace);
      return finished ? null : ("grace" as const);
    });
    const r = await Promise.race([child.exited, late]);
    finished = true;
    if (r === "grace") {
      this.o.log("error", "supervisor: child did not stop in time, killing it", { pid: child.pid });
      child.kill("SIGKILL");
      return child.exited;
    }
    return r ?? child.exited;
  }

  /** Run a helper subcommand to completion; returns its exit code. */
  private async runOnce(command: "flatten" | "cancel", attempt: number): Promise<number> {
    this.o.log("warn", `supervisor: running ${command}`);
    const c = this.o.spawn(command, [...(this.o.helperArgs ?? [])], attempt);
    this.child = c;
    this.childKind = command;
    const exit = await this.waitFor(c);
    this.child = null;
    this.childKind = null;
    return exit.code ?? 1;
  }

  /** Sleep for `ms`, waking early (returning false) when a stop or kill is requested. */
  private async pause(ms: number): Promise<boolean> {
    const until = this.now() + ms;
    while (this.now() < until) {
      if (this.stopping || this.exists(this.o.stopFile) || this.exists(this.o.killFile)) return false;
      await this.sleep(Math.min(1000, Math.max(1, until - this.now())));
    }
    return true;
  }

  /** Runs until the run is over; resolves with the process exit code the supervisor should use. */
  async run(): Promise<number> {
    const starts: number[] = [];
    let failures = 0;
    for (;;) {
      if (this.stopping) return this.end("stopped", 0, "signal");
      if (this.exists(this.o.killFile)) return this.end("stopped", 2, "kill file present");

      const remaining = this.o.endsAt == null ? null : this.o.endsAt - this.now();
      const stopRequested = this.exists(this.o.stopFile);
      if (stopRequested || (remaining !== null && remaining <= 0)) {
        // The run is meant to be over but no process is alive to finish it: close everything with a one-off command.
        this.o.log("warn", "supervisor: run is over and no process is running; closing positions", { reason: stopRequested ? "stop" : "deadline" });
        const code = await this.runOnce("flatten", this.status.starts);
        if (code === 0) {
          this.remove(this.o.stopFile);
          return this.end("stopped", 0, `closed positions (${stopRequested ? "stop" : "deadline"})`);
        }
        // The close-out itself failed: positions may still be open. Keep the STOP file (it still stands for "end this and
        // close everything") and report "a position could not be closed" so that nothing restarts the bot over them.
        this.o.log("error", "supervisor: closing the positions failed; they may still be open", { code });
        return this.end("stopped", 3, `closing positions failed (exit ${code})`);
      }

      const t = this.now();
      while (starts.length > 0 && t - starts[0]! >= HOUR) starts.shift();
      if (starts.length >= this.maxStarts) {
        // Too many starts: pull the quotes, then wait until the oldest start leaves the one-hour window.
        const resumeAt = starts[0]! + HOUR;
        this.o.log("error", "supervisor: too many restarts within an hour; quotes cancelled, trying again later", { starts: starts.length, afterSec: Math.round((resumeAt - t) / 1000) });
        this.set({ state: "throttled", detail: `${starts.length} starts within an hour`, nextStartAt: resumeAt });
        await this.runOnce("cancel", this.status.starts);
        this.set({ state: "throttled", nextStartAt: resumeAt });
        await this.pause(Math.max(1000, resumeAt - this.now()));
        continue;
      }
      starts.push(t);

      const attempt = this.status.starts + 1;
      const args = [...(this.o.liveArgs ?? [])];
      if (remaining !== null) args.push("--minutes", String(Math.max(1, Math.ceil(remaining / 60_000))));
      const child = this.o.spawn("live", args, attempt);
      this.child = child;
      this.childKind = "live";
      this.set({ state: "running", starts: attempt, restarts: attempt - 1, childPid: child.pid ?? null, childStartedAt: t, nextStartAt: null, detail: null });
      this.o.log("info", attempt === 1 ? "supervisor: started the bot" : "supervisor: restarted the bot", { pid: child.pid, attempt });

      const exit = await this.waitFor(child);
      this.child = null;
      this.childKind = null;
      const ranMs = this.now() - t;
      this.set({ childPid: null, lastExit: { code: exit.code, signal: exit.signal, at: this.now(), ranMs } });
      this.o.log(exit.code === 0 ? "info" : "warn", "supervisor: the bot exited", { code: exit.code, signal: exit.signal, ranSec: Math.round(ranMs / 1000) });

      if (exit.code === 0) return this.end("stopped", 0, "the run ended");
      if (exit.code === 2) return this.end("stopped", 2, "the bot halted itself; needs a person");
      if (exit.code === 3) return this.end("stopped", 3, "the run ended with a position that could not be closed");
      if (this.stopping) return this.end("stopped", 0, "signal");

      failures = ranMs >= this.healthyMs ? 0 : failures + 1;
      const wait = this.backoff[Math.min(Math.max(failures - 1, 0), this.backoff.length - 1)]!;
      this.set({ state: "backoff", nextStartAt: this.now() + wait, detail: `exit ${exit.code ?? exit.signal}` });
      this.o.log("warn", "supervisor: will restart the bot", { afterSec: Math.round(wait / 1000), failures });
      if (!(await this.pause(wait)) && this.stopping) return this.end("stopped", 0, "signal");
    }
  }

  private end(state: SupervisorState, code: number, detail: string): number {
    this.set({ state, detail, childPid: null, nextStartAt: null });
    this.o.log(code === 0 ? "info" : "error", "supervisor: finished", { code, detail });
    return code;
  }
}

/** What to execute for one supervised command. */
export interface ProcessSpec {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Builds the `spawn` option of {@link Supervisor} out of real child processes (stdout/stderr are inherited). */
export function processSpawner(build: (command: "live" | "flatten" | "cancel", extra: string[], attempt: number) => ProcessSpec): SuperviseOpts["spawn"] {
  return (command, extra, attempt) => {
    const spec = build(command, extra, attempt);
    const cp = spawn(spec.file, spec.args, { stdio: "inherit", env: { ...process.env, ...spec.env, MM_SUPERVISED_ATTEMPT: String(attempt) } });
    const exited = new Promise<ChildExit>((resolve) => {
      cp.once("exit", (code, signal) => resolve({ code, signal }));
      cp.once("error", () => resolve({ code: 1, signal: null }));
    });
    return {
      pid: cp.pid,
      exited,
      kill: (sig = "SIGTERM") => {
        try {
          cp.kill(sig);
        } catch {
          /* already gone */
        }
      },
    };
  };
}
