import { existsSync } from "node:fs";
import { loadConfig, loadLiveEnv } from "./config.js";
import type { Config } from "./config.js";
import { MarketMaker, jsonLogger } from "./engine.js";
import { DecibelExchange } from "./exchange/decibel.js";
import { PaperExchange } from "./exchange/paper.js";

const USAGE = `usage:
  tsx src/cli.ts paper [config.json] [--hours N]     simulated venue, no network
  tsx src/cli.ts check [config.json]                 read-only: connect, print markets/units/points
  tsx src/cli.ts live  [config.json] [--dry-run]     trade (env: APTOS_NODE_API_KEY MM_PRIVATE_KEY MM_SUBACCOUNT MM_OWNER)`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, maybePath] = process.argv.slice(2);
  const path = maybePath && !maybePath.startsWith("--") ? maybePath : "config.json";
  if (!cmd || !["paper", "check", "live"].includes(cmd)) {
    console.log(USAGE);
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`config file ${path} not found (copy config.example.json)`);
    process.exit(1);
  }
  const cfg = loadConfig(path);
  if (cmd === "paper") return runPaper(cfg, Number(arg("--hours") ?? 6));
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
  return runLive(cfg, ex);
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

async function runLive(cfg: Config, ex: DecibelExchange): Promise<void> {
  const specs = await ex.init(cfg.markets.map((m) => m.name));
  const mm = new MarketMaker(cfg, ex, specs, {
    persist: true,
    killSwitch: () => existsSync(cfg.engine.killSwitchFile),
  });
  let stopping = false;
  const stop = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    jsonLogger("warn", "shutting down, cancelling quotes", { sig });
    await mm.haltAll();
    await ex.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  jsonLogger("info", "market maker started", { markets: cfg.markets.map((m) => m.name), network: cfg.network });
  for (;;) {
    const started = Date.now();
    try {
      await mm.step(started);
    } catch (e) {
      jsonLogger("error", "step failed", { error: String(e) });
    }
    if (mm.isHalted) {
      jsonLogger("error", "halted; exiting");
      await ex.close();
      process.exit(2);
    }
    const wait = cfg.engine.tickMs - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
