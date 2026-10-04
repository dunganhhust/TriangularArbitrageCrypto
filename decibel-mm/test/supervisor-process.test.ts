import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor, processSpawner } from "../src/supervisor.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "stand-in-bot.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(script: string, over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mm-proc-"));
  dirs.push(dir);
  const spawn = processSpawner((command, extra) => ({
    file: process.execPath,
    args: [FIXTURE, command, ...extra],
    env: { STANDIN_DIR: dir, STANDIN_SCRIPT: script },
  }));
  const sup = new Supervisor({
    spawn,
    stopFile: join(dir, "STOP"),
    killFile: join(dir, "KILL"),
    statusFile: join(dir, "supervisor.json"),
    log: () => {},
    backoffMs: [20],
    maxStartsPerHour: 20,
    ...over,
  });
  const starts = () => readFileSync(join(dir, "starts.log"), "utf8").trim().split("\n").map((l) => l.trim());
  return { sup, starts, dir };
}

describe("Supervisor with real child processes", () => {
  it("restarts crashes and a watchdog exit, then stops on a clean exit", async () => {
    const h = make("1,75,70,0");
    expect(await h.sup.run()).toBe(0);
    expect(h.starts()).toEqual(["live 1", "live 2", "live 3", "live 4"]);
  });

  it("does not restart after a halt", async () => {
    const h = make("1,2,0");
    expect(await h.sup.run()).toBe(2);
    expect(h.starts()).toEqual(["live 1", "live 2"]);
  });

  it("forwards SIGTERM to a running bot and waits for it", async () => {
    const h = make("hang");
    const done = h.sup.run();
    // wait for the child to be up
    for (let i = 0; i < 200; i++) {
      try {
        if (h.starts().length > 0) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150)); // let it install its handler
    h.sup.requestStop();
    expect(await done).toBe(0);
    expect(h.starts()).toEqual(["live 1", "sigterm 1"]);
  }, 15_000);

  it("cancels and then waits instead of giving up when the bot keeps dying", async () => {
    const h = make("1", { maxStartsPerHour: 3 });
    const done = h.sup.run();
    // wait until the cancel run has happened, then stop the supervisor while it is throttled
    for (let i = 0; i < 400; i++) {
      try {
        if (h.starts().some((l) => l.startsWith("cancel"))) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h.starts()).toEqual(["live 1", "live 2", "live 3", "cancel 3"]);
    h.sup.requestStop();
    expect(await done).toBe(0);
  }, 15_000);
});
