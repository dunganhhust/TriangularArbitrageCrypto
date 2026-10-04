import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_GAVE_UP, Supervisor } from "../src/supervisor.js";
import type { Child, ChildExit } from "../src/supervisor.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Spawned {
  command: string;
  args: string[];
  attempt: number;
  killed: string[];
  exit(e: ChildExit): void;
}

function harness(over: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mm-sup-"));
  dirs.push(dir);
  let t = 1_000_000;
  const files = new Set<string>();
  const spawned: Spawned[] = [];
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const waiting: ((c: Spawned) => void)[] = [];
  const spawn = (command: "live" | "flatten" | "cancel", args: string[], attempt: number): Child => {
    let resolve!: (e: ChildExit) => void;
    const exited = new Promise<ChildExit>((r) => (resolve = r));
    const sp: Spawned = { command, args, attempt, killed: [], exit: (e) => resolve(e) };
    spawned.push(sp);
    waiting.shift()?.(sp);
    return { pid: 1000 + spawned.length, exited, kill: (sig = "SIGTERM") => void sp.killed.push(sig) };
  };
  const sup = new Supervisor({
    spawn,
    stopFile: "STOP",
    killFile: "KILL",
    statusFile: join(dir, "supervisor.json"),
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r)); // let the test drive the children between sleeps
    },
    exists: (p) => files.has(p),
    remove: (p) => void files.delete(p),
    pid: 4242,
    ...over,
  });
  /** Resolves with the n-th spawned child (1-based) once it exists. */
  const child = async (n: number): Promise<Spawned> => {
    while (spawned.length < n) await new Promise((r) => setImmediate(r));
    return spawned[n - 1]!;
  };
  const status = () => JSON.parse(readFileSync(join(dir, "supervisor.json"), "utf8")) as Record<string, any>;
  return { sup, spawned, logs, files, child, status, time: () => t, advance: (ms: number) => void (t += ms), dir, waiting };
}

describe("Supervisor", () => {
  it("a clean exit ends supervision with 0 and does not restart", async () => {
    const h = harness();
    const done = h.sup.run();
    (await h.child(1)).exit({ code: 0, signal: null });
    expect(await done).toBe(0);
    expect(h.spawned).toHaveLength(1);
    expect(h.status()).toMatchObject({ state: "stopped", starts: 1, restarts: 0, pid: 4242 });
  });

  it("a halt (2) or an unclosed position (3) ends supervision with the same code", async () => {
    for (const code of [2, 3]) {
      const h = harness();
      const done = h.sup.run();
      (await h.child(1)).exit({ code, signal: null });
      expect(await done).toBe(code);
      expect(h.spawned).toHaveLength(1);
    }
  });

  it.each([
    ["a crash", { code: 1, signal: null }],
    ["an uncaught error", { code: 70, signal: null }],
    ["a watchdog request", { code: 75, signal: null }],
    ["a kill signal", { code: null, signal: "SIGKILL" }],
  ])("restarts after %s, with a pause, and numbers the attempts", async (_n, exit) => {
    const h = harness();
    const done = h.sup.run();
    (await h.child(1)).exit(exit);
    const second = await h.child(2);
    expect(second.attempt).toBe(2);
    expect(second.command).toBe("live");
    expect(h.time()).toBeGreaterThanOrEqual(1_000_000 + 5_000); // first backoff step
    expect(h.status()).toMatchObject({ state: "running", starts: 2, restarts: 1, lastExit: { signal: exit.signal, code: exit.code } });
    second.exit({ code: 0, signal: null });
    expect(await done).toBe(0);
  });

  it("backs off longer after repeated quick failures and starts again from the shortest pause after a healthy run", async () => {
    const h = harness({ backoffMs: [1_000, 2_000, 4_000], healthyMs: 100_000, maxStartsPerHour: 99 });
    const done = h.sup.run();
    const gaps: number[] = [];
    let last = h.time();
    for (let i = 1; i <= 3; i++) {
      (await h.child(i)).exit({ code: 1, signal: null });
      await h.child(i + 1);
      gaps.push(h.time() - last);
      last = h.time();
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000]);
    // the fourth process runs for a long time before it fails: the failure counter starts over
    const fourth = await h.child(4);
    h.advance(200_000);
    const before = h.time();
    fourth.exit({ code: 1, signal: null });
    await h.child(5);
    expect(h.time() - before).toBe(1_000);
    (await h.child(5)).exit({ code: 0, signal: null });
    expect(await done).toBe(0);
  });

  it("gives up after too many starts within an hour, cancels the quotes and exits 4", async () => {
    const h = harness({ backoffMs: [10], maxStartsPerHour: 3 });
    const done = h.sup.run();
    for (let i = 1; i <= 3; i++) (await h.child(i)).exit({ code: 75, signal: null });
    const cancel = await h.child(4);
    expect(cancel.command).toBe("cancel");
    cancel.exit({ code: 0, signal: null });
    expect(await done).toBe(EXIT_GAVE_UP);
    expect(h.status()).toMatchObject({ state: "gave-up" });
    expect(h.logs.some((l) => l.level === "error" && l.msg.includes("giving up"))).toBe(true);
  });

  it("does not restart while the kill file exists", async () => {
    const h = harness({ backoffMs: [10_000] });
    const done = h.sup.run();
    (await h.child(1)).exit({ code: 1, signal: null });
    h.files.add("KILL");
    expect(await done).toBe(2);
    expect(h.spawned).toHaveLength(1);
  });

  it("a STOP request while the bot is down closes the positions with a one-off flatten instead of restarting", async () => {
    const h = harness({ backoffMs: [60_000] });
    const done = h.sup.run();
    (await h.child(1)).exit({ code: 1, signal: null });
    h.files.add("STOP");
    const flat = await h.child(2);
    expect(flat.command).toBe("flatten");
    flat.exit({ code: 0, signal: null });
    expect(await done).toBe(0);
    expect(h.files.has("STOP")).toBe(false);
  });

  it("a termination signal is passed to the bot and ends supervision once it has stopped", async () => {
    const h = harness();
    const done = h.sup.run();
    const c = await h.child(1);
    h.sup.requestStop();
    expect(c.killed).toEqual(["SIGTERM"]);
    expect(h.status().state).toBe("stopping");
    c.exit({ code: 0, signal: null });
    expect(await done).toBe(0);
    expect(h.spawned).toHaveLength(1);
  });

  it("a signal while a one-off flatten is closing positions lets it finish instead of killing it", async () => {
    const h = harness({ backoffMs: [60_000] });
    const done = h.sup.run();
    (await h.child(1)).exit({ code: 1, signal: null });
    h.files.add("STOP");
    const flat = await h.child(2);
    expect(flat.command).toBe("flatten");
    h.sup.requestStop();
    expect(flat.killed).toEqual([]); // not signalled
    flat.exit({ code: 0, signal: null });
    expect(await done).toBe(0);
  });

  it("a signal during the pause before a restart ends supervision without starting another bot", async () => {
    const h = harness({ backoffMs: [120_000] });
    const done = h.sup.run();
    (await h.child(1)).exit({ code: 1, signal: null });
    await new Promise((r) => setImmediate(r));
    h.sup.requestStop();
    expect(await done).toBe(0);
    expect(h.spawned).toHaveLength(1);
  });

  it("kills a bot that ignores the stop request past the grace period", async () => {
    const h = harness({ stopGraceMs: 5_000 });
    const done = h.sup.run();
    const c = await h.child(1);
    h.sup.requestStop();
    // the child does not exit by itself; after the grace period it is killed and then exits
    while (!c.killed.includes("SIGKILL")) await new Promise((r) => setImmediate(r));
    c.exit({ code: null, signal: "SIGKILL" });
    expect(await done).toBe(0);
  });

  it("passes the remaining time to every restarted bot and closes up when the deadline has passed", async () => {
    const h = harness({ endsAt: 1_000_000 + 5 * 60_000, backoffMs: [60_000], liveArgs: ["--dry-run"], maxStartsPerHour: 99 });
    const done = h.sup.run();
    const first = await h.child(1);
    expect(first.args).toEqual(["--dry-run", "--minutes", "5"]);
    first.exit({ code: 1, signal: null });
    const second = await h.child(2);
    expect(second.args.slice(0, 1)).toEqual(["--dry-run"]);
    expect(second.args.at(-1)).toBe("4"); // a minute of backoff has gone
    second.exit({ code: 1, signal: null });
    // more failures eat the remaining time; once it is gone the supervisor closes everything itself
    for (let n = 3; n < 20; n++) {
      const c = await h.child(n);
      if (c.command === "flatten") {
        c.exit({ code: 0, signal: null });
        break;
      }
      c.exit({ code: 1, signal: null });
    }
    expect(await done).toBe(0);
    expect(h.spawned.at(-1)!.command).toBe("flatten");
  });

  it("writes its status atomically for the dashboard", async () => {
    const h = harness();
    const done = h.sup.run();
    const c = await h.child(1);
    const s = h.status();
    expect(s).toMatchObject({ state: "running", childPid: 1001, starts: 1, endsAt: null });
    expect(typeof s.t).toBe("string");
    c.exit({ code: 0, signal: null });
    await done;
    writeFileSync(join(h.dir, "x"), "");
  });
});
