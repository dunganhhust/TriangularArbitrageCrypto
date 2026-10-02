import { existsSync, unlinkSync } from "node:fs";
import type { FlattenResult, Logger, MarketMaker } from "./engine.js";

export type RunEnd = "deadline" | "stop" | "halted";

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
    const wait = o.tickMs - (now() - started);
    if (wait > 0) await sleep(wait);
  }
}
