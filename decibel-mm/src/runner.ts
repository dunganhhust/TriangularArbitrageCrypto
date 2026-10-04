import { existsSync, unlinkSync } from "node:fs";
import type { FlattenResult, Logger, MarketMaker } from "./engine.js";

/** "restart": the watchdog found the data unusable for too long; quotes are pulled and the process should be started afresh. */
export type RunEnd = "deadline" | "stop" | "halted" | "restart";

export interface RunnerOpts {
  mm: MarketMaker;
  tickMs: number;
  /** Epoch ms at which the run must end (and close every position); null = run until stopped. */
  endsAt: number | null;
  /** Creating this file ends the run the same way. */
  stopFile: string;
  log: Logger;
  /** Called once when the run starts ending, before any order is sent to close positions. */
  onEnding?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void;
  /** Runs before each step; the simulator uses it to advance its clock. */
  beforeStep?: (now: number) => void;
  /** Consecutive failing steps after which the run asks for a restart (default 120, i.e. about 30 s). */
  maxStepFailures?: number;
}

export interface RunResult {
  end: RunEnd;
  /** Outcome of closing the positions; null when the run ended by a halt (quotes pulled, positions kept). */
  flat: FlattenResult | null;
}

/**
 * The control loop: step the market maker until the deadline passes, the STOP file appears, or the
 * engine halts itself. A deadline or STOP ends the run properly: pull quotes, close every position,
 * report whether that worked. A halt keeps its old meaning (quotes pulled, positions left alone).
 */
export async function runLoop(o: RunnerOpts): Promise<RunResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exists = o.exists ?? existsSync;
  const remove =
    o.remove ??
    ((p: string) => {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    });

  const finish = async (reason: "deadline" | "stop"): Promise<RunResult> => {
    o.onEnding?.();
    o.log("warn", "run ending: pulling quotes and closing every position", { reason });
    const flat = await o.mm.flattenAll();
    remove(o.stopFile);
    o.log(flat.closed ? "info" : "error", "run finished", { reason, flat: flat.closed, residual: flat.residual, dust: flat.dust });
    return { end: reason, flat };
  };

  let failures = 0;
  const maxFailures = o.maxStepFailures ?? 120;
  for (;;) {
    const started = now();
    if (o.endsAt !== null && started >= o.endsAt) return finish("deadline");
    if (exists(o.stopFile)) return finish("stop");
    try {
      o.beforeStep?.(started);
      await o.mm.step(started);
      failures = 0;
    } catch (e) {
      failures++;
      // A step that throws never reaches the engine's own health checks, so the runner is the one to notice it keeps failing.
      if (failures === 1 || failures % 20 === 0) o.log("error", "step failed", { error: String(e), consecutive: failures });
      if (failures >= maxFailures) {
        o.log("error", "watchdog: every step is failing; pulling quotes and asking for a restart", { consecutive: failures });
        try {
          await o.mm.haltAll();
        } catch {
          /* the exit path retries nothing more; the next process cleans up leftovers at start */
        }
        return { end: "restart", flat: null };
      }
    }
    if (o.mm.isHalted) return { end: "halted", flat: null };
    if (o.mm.restartRequested(now())) {
      o.log("error", "watchdog: market or account data unusable for too long; pulling quotes and asking for a restart");
      await o.mm.haltAll();
      return { end: "restart", flat: null };
    }
    const wait = o.tickMs - (now() - started);
    if (wait > 0) await sleep(wait);
  }
}

export interface ShutdownDeps {
  haltAll(): Promise<void>;
  close(): Promise<void>;
  exit(code: number): void;
  log: Logger;
  /** How long a fatal error waits for the quotes to be pulled before the process exits anyway (default 10 s). */
  fatalTimeoutMs?: number;
}

/**
 * Handles SIGINT / SIGTERM. A signal means "pull the quotes and stop", and the process must not exit until the
 * cancel transactions have been sent. `MarketMaker.haltAll()` marks the engine halted at once, so the control loop
 * sees a halt a moment later; without this class that loop's exit raced the cancels and could leave orders resting
 * on-chain. The loop now waits on `pending()` instead of exiting by itself.
 */
export class Shutdown {
  private promise: Promise<void> | null = null;
  private signals = 0;
  private ending = false;

  constructor(private readonly d: ShutdownDeps) {}

  /** The run is closing its positions: signals are ignored once, and a second one aborts. */
  markEnding(): void {
    this.ending = true;
  }

  onSignal(sig: string): Promise<void> {
    this.signals++;
    if (this.ending) {
      if (this.signals >= 2) {
        this.d.log("error", "aborted while closing positions: they may still be open", { sig });
        this.d.exit(1);
      } else {
        this.d.log("warn", "closing positions; send the signal again to abort", { sig });
      }
      return Promise.resolve();
    }
    if (this.promise) return this.promise;
    this.d.log("warn", "shutting down, cancelling quotes", { sig });
    this.promise = (async () => {
      try {
        await this.d.haltAll();
      } finally {
        try {
          await this.d.close();
        } finally {
          this.d.exit(0);
        }
      }
    })();
    return this.promise;
  }

  /**
   * An uncaught error or unhandled rejection. The quotes are pulled (bounded wait) and the process exits with 70, which a
   * supervisor reads as "restart me". Like a signal, this sets {@link pending} first, so the control loop that sees the
   * halt a moment later waits for it instead of exiting with its own code (2 = "needs a person") over the cancels.
   * While positions are being closed the error is only logged: exiting would abandon the close-out half way.
   */
  onFatal(what: string, err: unknown): void {
    const detail = String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 1500);
    if (this.promise) return; // already shutting down
    if (this.ending) {
      this.d.log("error", `${what} while closing positions: continuing the close-out`, { error: detail });
      return;
    }
    this.d.log("error", `${what}: pulling quotes and exiting`, { error: detail });
    this.promise = (async () => {
      try {
        await Promise.race([this.d.haltAll(), new Promise<void>((r) => setTimeout(r, this.d.fatalTimeoutMs ?? 10_000))]);
      } catch {
        /* exit regardless */
      } finally {
        this.d.exit(70);
      }
    })();
  }

  /** Non-null from the first signal until the process exits. */
  pending(): Promise<void> | null {
    return this.promise;
  }
}
