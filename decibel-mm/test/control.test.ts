import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, parseLog } from "../src/dashboard/analyze.js";
import { BotControl } from "../src/dashboard/control.js";
import { startDashboard } from "../src/dashboard/server.js";

const T0 = Date.parse("2026-10-02T10:00:00Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: iso(ms), level, msg, ...extra });

let dir: string;
let calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[];
let alive: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mm-ctl-"));
  mkdirSync(join(dir, "state"));
  mkdirSync(join(dir, "data"));
  calls = [];
  alive = true;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ network: "mainnet", markets: [{ name: "ETH/USD", maxPositionUsd: 15, levelSizeUsd: 5 }] }));
  writeFileSync(join(dir, "env"), "APTOS_NODE_API_KEY=x\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(over: Record<string, unknown> = {}, now = () => T0) {
  return new BotControl(
    {
      configPath: join(dir, "config.json"),
      envFile: join(dir, "env"),
      cwd: dir,
      tokenFile: join(dir, "state", "dashboard.token"),
      pidFile: join(dir, "state", "bot.pid"),
      stdoutFile: join(dir, "data", "stdout.log"),
      spawnFn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts: opts as Record<string, unknown> });
        return { pid: 4321, unref() {} };
      },
      isAlive: () => alive,
      scanBots: () => [],
      scanSupervisors: () => [],
      now,
      settleMs: 0,
      ...over,
    },
    { stopFile: join(dir, "state", "STOP"), killFile: join(dir, "state", "KILL") },
  );
}
const token = (): string => readFileSync(join(dir, "state", "dashboard.token"), "utf8").trim();

describe("token", () => {
  it("is created once, private to the owner, and reused by the next dashboard", () => {
    make();
    const t = token();
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(join(dir, "state", "dashboard.token")).mode & 0o077).toBe(0);
    make();
    expect(token()).toBe(t);
  });

  it("accepts only the exact token and locks out after repeated wrong guesses", () => {
    let now = T0;
    const c = make({}, () => now);
    expect(c.authorize(token())).toEqual({ ok: true });
    expect(c.authorize(undefined)).toMatchObject({ ok: false, code: 401 });
    expect(c.authorize(token().slice(1))).toMatchObject({ ok: false, code: 401 });
    c.authorize("wrong");
    c.authorize("wrong");
    expect(c.authorize("wrong")).toMatchObject({ ok: false, code: 401 }); // the 5th failure still answers 401 and arms the lock
    expect(c.authorize(token())).toMatchObject({ ok: false, code: 429 }); // even the right token waits
    now += 61_000;
    expect(c.authorize(token())).toEqual({ ok: true });
  });
});

describe("start", () => {
  it("runs the live command for the chosen number of minutes, with the keys read by the child shell only", async () => {
    const c = make();
    writeFileSync(join(dir, "state", "STOP"), "left over");
    const r = await c.start({ minutes: 90 }, null);
    expect(r).toMatchObject({ ok: true, pid: 4321, endsAt: T0 + 90 * MIN, dryRun: false });
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd).toBe("bash");
    expect(args.slice(0, 2)).toEqual(["-c", 'set -a; . "$1"; set +a; shift; exec "$@"']);
    expect(args).toContain(join(dir, "env"));
    expect(args.slice(args.indexOf("src/cli.ts"))).toEqual(["src/cli.ts", "live", join(dir, "config.json"), "--minutes", "90"]);
    expect(opts).toMatchObject({ detached: true, cwd: dir });
    expect((opts.env as Record<string, string>).MM_PRIVATE_KEY).toBeUndefined(); // the dashboard process holds no key
    expect(existsSync(join(dir, "state", "STOP"))).toBe(false); // a leftover STOP would end the new run at once
    expect(JSON.parse(readFileSync(join(dir, "state", "bot.pid"), "utf8"))).toMatchObject({ pid: 4321, minutes: 90 });
  });

  it("hands the child an absolute path to the key file, even when given a bare name", async () => {
    // `. env` would be looked up in PATH first; a relative or bare name must be made absolute.
    const c = make({ envFile: "env" });
    expect((await c.start({ minutes: 5 }, null)).ok).toBe(true);
    expect(calls[0]!.args[3]).toBe(join(dir, "env"));
    expect(calls[0]!.args[3]!.startsWith("/")).toBe(true);
  });

  it("the shell snippet really exports the file's variables to the command it execs", () => {
    const out = execFileSync("bash", ["-c", 'set -a; . "$1"; set +a; shift; exec "$@"', "t", join(dir, "env"), "sh", "-c", 'printf %s "$APTOS_NODE_API_KEY"'], { encoding: "utf8" });
    expect(out).toBe("x");
  });

  it("starts the 24/7 supervisor only when asked for it explicitly, with no end time", async () => {
    const c = make();
    const r = await c.start({ forever: true }, null);
    expect(r).toMatchObject({ ok: true, pid: 4321, endsAt: null, supervised: true });
    const { args } = calls[0]!;
    expect(args.slice(args.indexOf("src/cli.ts"))).toEqual(["src/cli.ts", "supervise", join(dir, "config.json")]);
    expect(JSON.parse(readFileSync(join(dir, "state", "bot.pid"), "utf8"))).toMatchObject({ pid: 4321, supervised: true, endsAt: 0 });
    const st = c.status(null);
    expect(st).toMatchObject({ running: true, supervised: true, endsAt: null, startedBy: "dashboard" });
  });

  it("a supervisor started by hand or by the service counts as a running bot, even with no live.json", () => {
    const c = make({ scanSupervisors: () => [777] }, () => T0);
    alive = false;
    const st = c.status(null);
    expect(st).toMatchObject({ running: true, supervised: true, legacy: false, pid: 777, startedBy: "external" });
  });

  it("a bare old-style bot without live.json is still flagged as legacy", () => {
    const c = make({ scanBots: () => [888] });
    alive = false;
    expect(c.status(null)).toMatchObject({ running: true, legacy: true, supervised: false });
  });

  it("can start a dry run", async () => {
    const r = await make().start({ minutes: 5, dryRun: true }, null);
    expect(r.ok).toBe(true);
    expect(calls[0]!.args.at(-1)).toBe("--dry-run");
  });

  it("rejects a missing, zero, negative, fractional-below-one or absurd duration", async () => {
    const c = make();
    for (const minutes of [undefined, 0, -5, 0.4, 10_081, NaN, "abc"]) {
      expect(await c.start({ minutes }, null)).toMatchObject({ ok: false, code: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses while a bot is already running, whoever started it", async () => {
    const c = make();
    expect((await c.start({ minutes: 10 }, null)).ok).toBe(true);
    expect(await c.start({ minutes: 10 }, null)).toMatchObject({ ok: false, code: 409 });
    alive = false; // the dashboard's bot is gone...
    const external = { t: new Date(T0 - 3_000).toISOString(), pid: 99 }; // ...but one started by hand is writing live.json
    expect(await c.start({ minutes: 10 }, external)).toMatchObject({ ok: false, code: 409 });
    expect(calls).toHaveLength(1);
  });

  it("refuses to start next to a bot it did not launch and cannot see in live.json (an older version)", async () => {
    const c = make({ scanBots: () => [555] });
    const r = await c.start({ minutes: 10 }, null);
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect((r as { error: string }).error).toContain("PID 555");
    expect(calls).toHaveLength(0);
    expect(c.status(null)).toMatchObject({ running: true, legacy: true, startedBy: "external", pid: 555 });
  });

  it("a bot that is writing live.json is not 'legacy'; End on a legacy one still writes STOP but says it may not listen", async () => {
    const fresh = { t: new Date(T0 - 1_000).toISOString(), pid: 600 };
    expect(make({ scanBots: () => [600] }).status(fresh)).toMatchObject({ running: true, legacy: false });
    const c = make({ scanBots: () => [555] });
    expect(c.stop(null)).toEqual({ ok: true, legacy: true, pid: 555 });
    expect(existsSync(join(dir, "state", "STOP"))).toBe(true);
  });

  it("the /proc scan finds a real `cli.ts live` process and ignores a dashboard one", async () => {
    const { scanLiveBots } = await import("../src/dashboard/control.js");
    const { spawn } = await import("node:child_process");
    const live = spawn("sh", ["-c", "sleep 30", "src/cli.ts", "live", "config.json"], { stdio: "ignore" });
    const dash = spawn("sh", ["-c", "sleep 30", "src/cli.ts", "dashboard", "config.json"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const found = scanLiveBots();
      expect(found).toContain(live.pid);
      expect(found).not.toContain(dash.pid);
    } finally {
      live.kill();
      dash.kill();
    }
  });

  it("refuses with the KILL file present, a missing key file, or a broken config", async () => {
    writeFileSync(join(dir, "state", "KILL"), "");
    expect(await make().start({ minutes: 10 }, null)).toMatchObject({ ok: false, code: 409 });
    rmSync(join(dir, "state", "KILL"));
    rmSync(join(dir, "env"));
    expect(await make().start({ minutes: 10 }, null)).toMatchObject({ ok: false, code: 400 });
    writeFileSync(join(dir, "env"), "x");
    writeFileSync(join(dir, "config.json"), "{ not json");
    expect(await make().start({ minutes: 10 }, null)).toMatchObject({ ok: false, code: 400 });
    expect(calls).toHaveLength(0);
  });

  it("reports a bot that dies on launch, with the end of its output", async () => {
    const c = make();
    writeFileSync(join(dir, "data", "stdout.log"), "Error: MM_PRIVATE_KEY is not set\n", { flag: "a" });
    const spawn = c as unknown as { o: { isAlive: () => boolean } };
    spawn.o.isAlive = () => false;
    const r = await c.start({ minutes: 10 }, null);
    expect(r).toMatchObject({ ok: false, code: 500 });
    expect((r as { detail?: string }).detail).toContain("MM_PRIVATE_KEY");
  });
});

describe("stop and status", () => {
  it("stop writes the STOP file only when a bot is running, and never signals anything", async () => {
    const c = make();
    expect(c.stop(null)).toMatchObject({ ok: false, code: 409 });
    expect(existsSync(join(dir, "state", "STOP"))).toBe(false);
    await c.start({ minutes: 30 }, null);
    expect(c.stop(null)).toEqual({ ok: true });
    expect(existsSync(join(dir, "state", "STOP"))).toBe(true);
    expect(c.status(null)).toMatchObject({ running: true, stopRequested: true, startedBy: "dashboard", pid: 4321 });
  });

  it("stop also works on a bot started outside the dashboard (it is seen through live.json)", () => {
    const c = make();
    const live = { t: new Date(T0 - 2_000).toISOString(), pid: 77, endsAt: T0 + 20 * MIN };
    expect(c.status(live)).toMatchObject({ running: true, startedBy: "external", pid: 77, endsAt: T0 + 20 * MIN });
    expect(c.stop(live)).toEqual({ ok: true });
  });

  it("status summarises the config the next run will use", () => {
    const st = make().status(null) as { config: { network: string; markets: { name: string }[] }; running: boolean; envFileOk: boolean };
    expect(st).toMatchObject({ running: false, envFileOk: true });
    expect(st.config.network).toBe("mainnet");
    expect(st.config.markets[0]!.name).toBe("ETH/USD");
  });
});

describe("HTTP routes", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function serve(control: boolean) {
    const srv = await startDashboard({
      port: 0,
      logFile: join(dir, "data", "run.log"),
      liveFile: join(dir, "data", "live.json"),
      killFile: join(dir, "state", "KILL"),
      stopFile: join(dir, "state", "STOP"),
      priceFeed: null,
      control: control
        ? { configPath: join(dir, "config.json"), envFile: join(dir, "env"), cwd: dir, tokenFile: join(dir, "state", "dashboard.token"), pidFile: join(dir, "state", "bot.pid"), stdoutFile: join(dir, "data", "stdout.log"), spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts: opts as Record<string, unknown> }); return { pid: 4321, unref() {} }; }, isAlive: () => alive, scanBots: () => [], settleMs: 0 }
        : null,
    });
    servers.push(srv);
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }
  const post = (base: string, path: string, body: unknown, tok?: string) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { "x-mm-token": tok } : {}) }, body: JSON.stringify(body) });

  it("is read-only unless the dashboard was started with control", async () => {
    const base = await serve(false);
    expect((await post(base, "/api/control/start", { minutes: 5 })).status).toBe(404);
    expect((await fetch(base + "/api/data").then((r) => r.json())).control).toEqual({ enabled: false });
    expect(calls).toHaveLength(0);
  });

  it("rejects requests without the token and accepts them with it", async () => {
    const base = await serve(true);
    expect((await post(base, "/api/control/start", { minutes: 5 })).status).toBe(401);
    expect((await post(base, "/api/control/start", { minutes: 5 }, "nope")).status).toBe(401);
    expect(calls).toHaveLength(0);

    const ok = await post(base, "/api/control/start", { minutes: 5, dryRun: true }, token());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, pid: 4321 });
    expect(calls).toHaveLength(1);

    const again = await post(base, "/api/control/start", { minutes: 5 }, token());
    expect(again.status).toBe(409);

    const data = (await fetch(base + "/api/data").then((r) => r.json())) as { control: { enabled: boolean; running: boolean; startedBy: string } };
    expect(data.control).toMatchObject({ enabled: true, running: true, startedBy: "dashboard" });

    const stop = await post(base, "/api/control/stop", {}, token());
    expect(stop.status).toBe(200);
    expect(existsSync(join(dir, "state", "STOP"))).toBe(true);
  });

  it("answers a body that is not JSON with 400, and an unknown control path with 404", async () => {
    const base = await serve(true);
    const bad = await fetch(base + "/api/control/start", { method: "POST", headers: { "x-mm-token": token() }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await post(base, "/api/control/nope", {}, token())).status).toBe(404);
  });

  it("does not let a GET start or stop anything", async () => {
    const base = await serve(true);
    expect((await fetch(base + "/api/control/start?minutes=5")).status).toBe(404); // only POST is routed
    expect(calls).toHaveLength(0);
  });
});

describe("how the dashboard reads a run that ends", () => {
  const START = line(0, "info", "market maker started", { markets: ["ETH/USD"], pid: 5, endsAt: iso(2 * 60 * MIN), marketCfg: [], limits: {} });
  const opts = (nowMs: number, over: Record<string, unknown> = {}) => ({ now: T0 + nowMs, staleMs: 120_000, aptUsd: 1, killFile: false, ...over });

  it("shows the time left from the start line, or from live.json when present", () => {
    const lines = parseLog([START, line(60_000, "info", "status", { equity: 20 })].join("\n"));
    const d = analyze(lines, opts(70_000));
    expect(d.run.endsAt).toBe(T0 + 120 * MIN);
    expect(d.run.remainingSec).toBe(120 * 60 - 70);
    const live = analyze(lines, opts(70_000, { live: { t: iso(69_000), pid: 5, equity: 20, endsAt: T0 + 30 * MIN } }));
    expect(live.run.remainingSec).toBe(30 * 60 - 70);
  });

  it("is 'finishing' while positions are being closed, and a silent bot at that point is flagged", () => {
    const lines = parseLog([START, line(60_000, "info", "status", { equity: 20 }), line(7_200_000, "warn", "run ending: pulling quotes and closing every position", { reason: "deadline" })].join("\n"));
    const d = analyze(lines, opts(7_203_000));
    expect(d.run.state).toBe("finishing");
    expect(d.alerts.map((a) => a.text).join(" ")).toContain("đóng toàn bộ vị thế");
    const dead = analyze(lines, opts(7_200_000 + 10 * MIN));
    expect(dead.run.state).toBe("stale");
    expect(dead.run.detail).toContain("khi đang đóng vị thế");
  });

  it("ends as 'stopped' with a green result when everything was closed", () => {
    const lines = parseLog([START, line(60_000, "info", "status", { equity: 20 }), line(7_200_000, "warn", "run ending: pulling quotes and closing every position", { reason: "deadline" }), line(7_204_000, "info", "run finished", { reason: "deadline", flat: true, residual: {}, dust: {} })].join("\n"));
    const d = analyze(lines, opts(7_300_000));
    expect(d.run.state).toBe("stopped");
    expect(d.run.detail).toContain("hết giờ");
    expect(d.run.finish).toMatchObject({ closed: true, reason: "deadline" });
    expect(d.alerts.filter((a) => a.level === "error")).toHaveLength(0);
    expect(d.run.remainingSec).toBeNull();
  });

  it("raises an error when the run ended with a position still open", () => {
    const lines = parseLog([START, line(7_200_000, "error", "run finished", { reason: "stop", flat: false, residual: { "ETH/USD": 0.0017 }, dust: { "BTC/USD": 0.00004 } })].join("\n"));
    const d = analyze(lines, opts(7_300_000));
    expect(d.run.state).toBe("stopped");
    expect(d.run.finish).toMatchObject({ closed: false, residual: { "ETH/USD": 0.0017 } });
    const texts = d.alerts.map((a) => a.text).join(" | ");
    expect(texts).toContain("còn vị thế chưa đóng");
    expect(texts).toContain("quá nhỏ");
  });
});
