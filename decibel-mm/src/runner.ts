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

  for (;;) {
    const started = now();
    if (o.endsAt !== null && started >= o.endsAt) return finish("deadline");
    if (exists(o.stopFile)) return finish("stop");
    try {
      o.beforeStep?.(started);
      await o.mm.step(started);
    } catch (e) {
      o.log("error", "step failed", { error: String(e) });
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

  /** Non-null from the first signal until the process exits. */
  pending(): Promise<void> | null {
    return this.promise;
  }
}
