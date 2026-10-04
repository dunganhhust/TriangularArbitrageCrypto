import { existsSync, statSync, unlinkSync } from "node:fs";
import { loadConfig, loadLiveEnv } from "./config.js";
import type { Config } from "./config.js";
import { PriceFeed } from "./dashboard/price.js";
import { startDashboard } from "./dashboard/server.js";
import { MarketMaker, jsonLogger, setRunLogFile } from "./engine.js";
import { DecibelExchange } from "./exchange/decibel.js";
import { PaperExchange } from "./exchange/paper.js";
import { runLoop, Shutdown } from "./runner.js";
import { Supervisor, processSpawner } from "./supervisor.js";

const USAGE = `usage:
  tsx src/cli.ts paper [config.json] [--hours N]     simulated venue, no network
  tsx src/cli.ts check [config.json]                 read-only: connect, print markets/units/points
  tsx src/cli.ts live  [config.json] [--dry-run] [--minutes N]
                                                     trade (env: APTOS_NODE_API_KEY MM_PRIVATE_KEY MM_SUBACCOUNT MM_OWNER).
                                                     With --minutes the run ends after N minutes: quotes are pulled and every
                                                     position is closed. Creating the STOP file does the same at any time.
  tsx src/cli.ts supervise [config.json] [--dry-run] [--minutes N]
                                                     24/7 mode: runs "live" and starts it again after a crash or a watchdog exit
                                                     (growing pauses, gives up after too many restarts); never restarts after
                                                     End / a halt. Same environment variables as live.
  tsx src/cli.ts flatten [config.json] [--dry-run]   pull quotes and close every open position now, then exit
  tsx src/cli.ts cancel [config.json]                pull every resting quote now (positions are kept), then exit
  tsx src/cli.ts dashboard [config.json] [--port N] [--control] [--env-file PATH]
                                                     web page on 127.0.0.1 (default 8787) showing the live run; with --control it
                                                     also has Start / End buttons (needs the token in state/dashboard.token)`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, maybePath] = process.argv.slice(2);
  const path = maybePath && !maybePath.startsWith("--") ? maybePath : "config.json";
  if (!cmd || !["paper", "check", "live", "flatten", "cancel", "supervise", "dashboard"].includes(cmd)) {
    console.log(USAGE);
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`config file ${path} not found (copy config.example.json)`);
    process.exit(1);
  }
  const cfg = loadConfig(path);
  if (cmd === "paper") return runPaper(cfg, Number(arg("--hours") ?? 6));
  if (cmd === "dashboard") return runDashboard(cfg, path);
  if (cmd === "supervise") return runSupervise(cfg, path);
  if (cmd === "live") setRunLogFile(cfg.engine.runLogFile, cfg.engine.logMaxBytes);
  const env = loadLiveEnv();
  const ex = new DecibelExchange({
    network: cfg.network,
    env,
    dryRun: process.argv.includes("--dry-run"),
    encrypted: cfg.execution.encrypted,
    priceUnits: cfg.live.priceUnits,
    sizeUnits: cfg.live.sizeUnits,
    log: (msg, extra) => jsonLogger("info", msg, extra),
  });
  if (cmd === "check") {
    await ex.init(cfg.markets.map((m) => m.name));
    console.log(JSON.stringify(await ex.report(), null, 2));
    await ex.close();
    process.exit(0);
  }
  if (cmd === "flatten") return runFlatten(cfg, ex, process.argv.includes("--dry-run"));
  if (cmd === "cancel") return runCancel(cfg, ex);
  return runLive(cfg, ex, process.argv.includes("--dry-run"));
}

/** Pull quotes and close every position, then exit: 0 when flat, 3 when something could not be closed. */
async function runFlatten(cfg: Config, ex: DecibelExchange, dryRun: boolean): Promise<void> {
  // systemd (or a supervisor) sends SIGTERM when a service stops; leaving positions half closed because of it would be
  // the wrong reading of "stop". Ctrl+C (SIGINT) still aborts.
  process.on("SIGTERM", () => jsonLogger("warn", "flatten: SIGTERM ignored while closing positions"));
  const names = cfg.markets.map((m) => m.name);
  const specs = await ex.init(names);
  const mm = new MarketMaker(cfg, ex, specs, {});
  const before = Object.fromEntries(names.map((n) => [n, ex.getPosition(n)]));
  const res = await mm.flattenAll({ attempts: dryRun ? 1 : undefined });
  const after = Object.fromEntries(names.map((n) => [n, ex.getPosition(n)]));
  await ex.close();
  console.log(JSON.stringify({ dryRun, before, after, ...res }, null, 2));
  process.exit(res.closed ? 0 : 3);
}

/** Pull every resting quote and report what is still listed, then exit: 0 when nothing is left, 3 otherwise. */
async function runCancel(cfg: Config, ex: DecibelExchange): Promise<void> {
  const names = cfg.markets.map((m) => m.name);
  const specs = await ex.init(names);
  const mm = new MarketMaker(cfg, ex, specs, {});
  await mm.cancelAll();
  const left = (await ex.listResting().catch(() => names)).filter((n) => names.includes(n));
  await ex.close();
  console.log(JSON.stringify({ cancelled: names, stillResting: left }, null, 2));
  process.exit(left.length === 0 ? 0 : 3);
}

/** Runs `live` under a supervisor that restarts it after crashes; see supervisor.ts for what is and is not restarted. */
async function runSupervise(cfg: Config, configPath: string): Promise<void> {
  loadLiveEnv(); // fail here, once and clearly, instead of in every restarted process
  const launched = Date.now();
  // An End pressed in an earlier session must not close this one's positions on its first look.
  try {
    if (existsSync(cfg.engine.stopFile) && statSync(cfg.engine.stopFile).mtimeMs < launched - 1000) {
      unlinkSync(cfg.engine.stopFile);
      jsonLogger("warn", "removed a stale STOP file from an earlier session");
    }
  } catch {
    /* best effort */
  }
  setRunLogFile(cfg.engine.runLogFile, 0); // the supervised processes rotate the file; this one only adds a few lines
  const minutesArg = arg("--minutes");
  let endsAt: number | null = null;
  if (minutesArg !== undefined) {
    const minutes = Number(minutesArg);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10_080) {
      console.error(`--minutes must be between 1 and 10080, got ${minutesArg}`);
      process.exit(1);
    }
    endsAt = Date.now() + Math.round(minutes * 60_000);
  }
  // Same launcher, same flags (e.g. --import tsx), same script: the children are this program's own subcommands.
  const spawnChild = processSpawner((command, extra) => ({ file: process.execPath, args: [...process.execArgv, process.argv[1]!, command, configPath, ...extra] }));
  const sup = new Supervisor({
    spawn: spawnChild,
    stopFile: cfg.engine.stopFile,
    killFile: cfg.engine.killSwitchFile,
    statusFile: "state/supervisor.json",
    log: jsonLogger,
    endsAt,
    liveArgs: process.argv.includes("--dry-run") ? ["--dry-run"] : [],
    helperArgs: process.argv.includes("--dry-run") ? ["--dry-run"] : [], // a dry run must not send real close-out orders either
  });
  process.on("SIGINT", () => sup.requestStop());
  process.on("SIGTERM", () => sup.requestStop());
  process.exit(await sup.run());
}

/** Read-only page over data/run.log. Needs no keys; bound to loopback only (use an SSH tunnel to see it remotely). */
async function runDashboard(cfg: Config, configPath: string): Promise<void> {
  const port = Number(arg("--port") ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port ${arg("--port")}`);
    process.exit(1);
  }
  if (!cfg.engine.runLogFile) {
    console.error("engine.runLogFile is empty: the bot writes no run log, so there is nothing to show");
    process.exit(1);
  }
  const control = process.argv.includes("--control")
    ? { configPath, envFile: arg("--env-file") ?? "/etc/decibel-mm/env" }
    : null;
  // The dashboard only reads files and answers HTTP: an unexpected error in one request must not take it down.
  process.on("unhandledRejection", (e) => console.error("dashboard: unhandled rejection (continuing)", e));
  process.on("uncaughtException", (e) => console.error("dashboard: uncaught exception (continuing)", e));
  await startDashboard({
    port,
    logFile: cfg.engine.runLogFile,
    liveFile: cfg.engine.liveFile,
    killFile: cfg.engine.killSwitchFile,
    stopFile: cfg.engine.stopFile,
    supervisorFile: "state/supervisor.json",
    control: control ? { ...control, cwd: process.cwd(), tokenFile: "state/dashboard.token", pidFile: "state/bot.pid", stdoutFile: "data/stdout.log" } : null,
  });
  console.log(`dashboard: http://localhost:${port}  (reads ${cfg.engine.runLogFile}; Ctrl+C to stop)`);
  if (control) console.log("điều khiển: BẬT (nút Bắt đầu / Kết thúc). Mã truy cập nằm trong state/dashboard.token (chỉ chủ tài khoản đọc được)");
}

/** Fast-forward simulation: one engine step per `tickMs` of simulated time. */
async function runPaper(cfg: Config, hours: number): Promise<void> {
  const names = cfg.markets.map((m) => m.name);
  const ex = new PaperExchange(cfg.paper, names);
  const specs = await ex.init(names);
  let statuses = 0;
  const quiet = (level: string, msg: string, extra?: Record<string, unknown>) => {
    // Status is emitted every 30 simulated seconds; print one per simulated hour.
    if (msg === "status" ? statuses++ % 120 === 0 : level !== "info") jsonLogger(level as "info", msg, extra);
  };
  const mm = new MarketMaker(cfg, ex, specs, { log: quiet });
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const end = t0 + hours * 3_600_000;
  const startEquity = ex.getAccount().equityUsd;
  let fills = 0;
  let vol = 0;
  const origDrain = ex.drainFills.bind(ex);
  ex.drainFills = () => {
    const f = origDrain();
    for (const x of f) {
      fills++;
      vol += x.price * x.size;
    }
    return f;
  };
  for (let now = t0; now <= end && !mm.isHalted; now += cfg.engine.tickMs) {
    ex.advance(now);
    await mm.step(now);
  }
  await mm.cancelAll();
  const s = mm.points.stats(end);
  const eq = ex.getAccount().equityUsd;
  console.log(
    JSON.stringify(
      {
        simulatedHours: hours,
        fills,
        volumeUsd: Math.round(vol),
        txCount: ex.txCount,
        pnlUsd: Number((eq - startEquity).toFixed(2)),
        pnlBpsOfVolume: vol > 0 ? Number((((eq - startEquity) / vol) * 1e4).toFixed(3)) : null,
        finalSpreadMult: Number(s.spreadMult.toFixed(3)),
        positions: Object.fromEntries(names.map((n) => [n, ex.getPosition(n)])),
        note: "Simulator only. It checks that the engine behaves; it does not predict live PnL or Amps.",
      },
      null,
      2,
    ),
  );
}

async function runLive(cfg: Config, ex: DecibelExchange, dryRun: boolean): Promise<void> {
  const launched = Date.now();
  const minutesArg = arg("--minutes");
  let endsAt: number | null = null;
  if (minutesArg !== undefined) {
    const minutes = Number(minutesArg);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10_080) {
      console.error(`--minutes must be between 1 and 10080, got ${minutesArg}`);
      process.exit(1);
    }
    endsAt = launched + Math.round(minutes * 60_000);
  }
  // First line of the run: the dashboard treats everything after the latest such line as the current run.
  jsonLogger("info", "market maker started", {
    markets: cfg.markets.map((m) => m.name),
    network: cfg.network,
    dryRun,
    pid: process.pid,
    supervisedAttempt: process.env.MM_SUPERVISED_ATTEMPT ? Number(process.env.MM_SUPERVISED_ATTEMPT) : null,
    endsAt: endsAt === null ? null : new Date(endsAt).toISOString(),
    marketCfg: cfg.markets.map((m) => ({ name: m.name, maxPositionUsd: m.maxPositionUsd, levelSizeUsd: m.levelSizeUsd, levels: m.levels })),
    limits: {
      maxDrawdownUsd: cfg.risk.maxDrawdownUsd,
      minGasBalanceApt: cfg.risk.minGasBalanceApt,
      maxGasAptPerDay: cfg.risk.maxGasAptPerDay,
      rebateBps: cfg.rebate.bps,
      minMakerRatio: cfg.rebate.minMakerRatio,
      minReplaceIntervalMs: cfg.engine.minReplaceIntervalMs,
      rampStages: cfg.ramp.enabled ? cfg.ramp.stages : null,
    },
  });
  // A STOP file left over from an earlier run must not end this one; one written after launch is honoured. Under a
  // supervisor the supervisor owns this policy (it clears stale files when it starts), so a STOP written while this
  // process was still loading is not mistaken for a stale one.
  try {
    if (!process.env.MM_SUPERVISED_ATTEMPT && existsSync(cfg.engine.stopFile) && statSync(cfg.engine.stopFile).mtimeMs < launched - 1000) {
      unlinkSync(cfg.engine.stopFile);
      jsonLogger("warn", "removed a stale STOP file from an earlier run");
    }
  } catch {
    /* best effort */
  }

  const specs = await ex.init(cfg.markets.map((m) => m.name));
  // Gas is paid in APT; its dollar value lets the controllers weigh it against edge. A dead feed just means "unknown".
  const aptFeed = cfg.gas.priceFeed ? new PriceFeed({ everyMs: 30_000 }) : null;
  aptFeed?.start();
  const mm = new MarketMaker(cfg, ex, specs, {
    persist: true,
    killSwitch: () => existsSync(cfg.engine.killSwitchFile),
    endsAt,
    aptUsd: () => {
      const r = aptFeed?.get();
      return r && !r.stale ? r.usd : null;
    },
  });
  const shutdown = new Shutdown({ haltAll: () => mm.haltAll(), close: () => ex.close(), exit: (c) => process.exit(c), log: jsonLogger });
  // A bug that surfaces as an uncaught error must not leave quotes resting with nobody watching them: pull them, then
  // exit 70 so that the supervisor starts a fresh process (see Shutdown.onFatal).
  process.on("uncaughtException", (e) => shutdown.onFatal("uncaught exception", e));
  process.on("unhandledRejection", (e) => shutdown.onFatal("unhandled rejection", e));
  if (!dryRun) await mm.cleanupLeftovers();
  process.on("SIGINT", () => void shutdown.onSignal("SIGINT"));
  process.on("SIGTERM", () => void shutdown.onSignal("SIGTERM"));

  const res = await runLoop({
    mm,
    tickMs: cfg.engine.tickMs,
    endsAt,
    stopFile: cfg.engine.stopFile,
    log: jsonLogger,
    onEnding: () => shutdown.markEnding(),
  });
  // A signal already started cancelling the quotes: let that finish (it exits the process) instead of racing it.
  const cancelling = shutdown.pending();
  if (cancelling) {
    await cancelling;
    return;
  }
  await ex.close();
  if (res.end === "halted") {
    jsonLogger("error", "halted; exiting");
    process.exit(2);
  }
  if (res.end === "restart") process.exit(75);
  process.exit(res.flat?.closed ? 0 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
