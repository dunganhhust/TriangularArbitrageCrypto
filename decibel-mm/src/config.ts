import { readFileSync } from "node:fs";
import { z } from "zod";

const marketSchema = z.object({
  name: z.string().min(1),
  /** Max |position| in USD before quotes go one-sided. */
  maxPositionUsd: z.number().positive(),
  levels: z.number().int().min(1).max(10).default(3),
  baseHalfSpreadBps: z.number().nonnegative().default(2),
  levelStepBps: z.number().nonnegative().default(1.5),
  levelSizeUsd: z.number().positive(),
  sizeGrowth: z.number().positive().default(1.25),
  inventorySkewBps: z.number().nonnegative().default(6),
  minHalfSpreadBps: z.number().nonnegative().default(0.6),
  volK: z.number().nonnegative().default(0.5),
});

export const configSchema = z.object({
  network: z.enum(["mainnet", "testnet"]).default("testnet"),
  markets: z.array(marketSchema).min(1),

  engine: z
    .object({
      tickMs: z.number().int().positive().default(250),
      /** Minimum gap between on-chain ladder replacements per market. */
      minReplaceIntervalMs: z.number().int().positive().default(3000),
      repriceBps: z.number().positive().default(2),
      sizeTol: z.number().positive().default(0.15),
      /** Even urgent replacements wait at least this long since the previous one (caps gas burn). */
      hardMinReplaceIntervalMs: z.number().int().positive().default(1000),
      /**
       * Replace immediately (ignoring the interval) when the opposite touch is within this many bps of
       * crossing our top quote. 0 = only when it has actually reached or passed it.
       */
      threatBps: z.number().nonnegative().default(0),
      /**
       * Replace right away (still respecting hardMinReplaceIntervalMs) when the best bid or ask of
       * the target ladder has moved this far from the live one. Keeps quotes from going stale
       * between the slow scheduled refreshes, which is what bots watching the price pick off.
       */
      urgentRepriceBps: z.number().positive().default(6),
      /** Bounds (bps) for the economic reprice threshold below. */
      urgentMinBps: z.number().positive().default(2),
      urgentMaxBps: z.number().positive().default(10),
      /**
       * Chance that a stale quote gets hit once the price has moved through it. With the APT price known, the
       * immediate-reprice threshold becomes half-spread + (gas of one transaction in bps of the top level) / this,
       * within [urgentMinBps, urgentMaxBps]: the drift at which the expected loss from a stale quote starts to
       * exceed the gas of fixing it. Bigger levels (or cheaper gas, or a wide spread) re-quote sooner or later
       * accordingly; tiny levels wait. 0 = off (always `urgentRepriceBps`).
       */
      staleFillProb: z.number().min(0).max(1).default(0.3),
      /** While gas runs ahead of its daily budget, thresholds and refresh intervals are stretched by up to this factor. */
      economyMaxMult: z.number().min(1).default(3),
      /** Randomise each refresh interval by +/- this fraction so the cadence is not predictable. */
      jitterPct: z.number().min(0).max(0.9).default(0.2),
      volWindowMs: z.number().int().positive().default(60_000),
      stateFile: z.string().default("state/state.json"),
      killSwitchFile: z.string().default("state/KILL"),
      /** Creating this file ends the run gracefully: pull quotes, close every position, exit. */
      stopFile: z.string().default("state/STOP"),
      pointsLogFile: z.string().default("data/points_log.csv"),
      /** One row per finished UTC day (volume, fees, gas, equity change, ...). "" = off. */
      dailyLogFile: z.string().default("data/daily.csv"),
      /** run.log is moved to run.log.1 when it grows past this many bytes (0 = never). */
      logMaxBytes: z.number().int().nonnegative().default(50_000_000),
      /**
       * Exit with a restart request (code 75) after the market data or the account data has been unusable for this
       * long, so a supervisor can start a fresh process with fresh connections. 0 = never.
       */
      watchdogMs: z.number().int().nonnegative().default(180_000),
      /** Every log line of a live run is also appended here; the dashboard reads it. "" = off. */
      runLogFile: z.string().default("data/run.log"),
      /** Latest-state snapshot, rewritten every liveEveryMs; the dashboard shows it second by second. "" = off. */
      liveFile: z.string().default("data/live.json"),
      liveEveryMs: z.number().int().positive().default(1_000),
      statusEveryMs: z.number().int().positive().default(30_000),
      pointsPollEveryMs: z.number().int().positive().default(300_000),
    })
    .default({}),

  points: z
    .object({
      costBudgetBps: z.number().default(0.5),
      minSpreadMult: z.number().positive().default(0.6),
      maxSpreadMult: z.number().positive().default(4),
      dailyVolumeTargetUsd: z.number().nonnegative().default(100_000),
      streakMinVolumeUsd: z.number().nonnegative().default(10_000),
      markoutMs: z.number().int().positive().default(5_000),
      ewmaHalfLifeUsd: z.number().positive().default(25_000),
      minSampleUsd: z.number().nonnegative().default(2_000),
      step: z.number().gt(1).default(1.05),
      controlIntervalMs: z.number().int().positive().default(30_000),
    })
    .default({}),

  risk: z
    .object({
      staleBookMs: z.number().int().positive().default(3_000),
      maxOracleDevBps: z.number().positive().default(40),
      maxSpreadBps: z.number().positive().default(25),
      emergencyPositionMult: z.number().gt(1).default(1.5),
      reduceToMult: z.number().min(0).max(1).default(0.5),
      maxDrawdownUsd: z.number().positive().default(50),
      maxConsecutiveFailures: z.number().int().positive().default(4),
      cooldownMs: z.number().int().positive().default(15_000),
      /**
       * Halt (and cancel quotes) when the signer's APT balance falls below this. Keep it high
       * enough that the cancel transaction itself can still be paid for.
       */
      minGasBalanceApt: z.number().nonnegative().default(0.05),
      /** Stop quoting for the rest of the UTC day once this much APT of gas has been spent. */
      maxGasAptPerDay: z.number().positive().default(0.5),
      /** Pull quotes while positions or the account have not been refreshed for this long: the bot is blind. */
      maxDataStaleMs: z.number().int().positive().default(30_000),
      /**
       * Absolute floor on account equity (USD): below it the bot halts. Unlike `maxDrawdownUsd` (measured from the
       * start of each process) this survives restarts, which is what an unattended run needs. 0 = off.
       */
      minEquityUsd: z.number().nonnegative().default(0),
      /**
       * Daily loss limit (USD, from the first equity seen each UTC day): past it every position is closed and the bot
       * stays flat until the next UTC day, then resumes by itself. 0 = off.
       */
      maxDailyLossUsd: z.number().nonnegative().default(0),
    })
    .default({}),

  /**
   * Size the book from the account instead of fixed numbers. With `leverage` > 0 the cap on |position| is
   * equity x leverage split over the markets and the level size is `levelFraction` of that cap; the per-market
   * `maxPositionUsd` / `levelSizeUsd` stay as ceilings (set them high to let volume follow deposits). Losses
   * therefore shrink the book by themselves and a deposit grows it, with no config edit. 0 = fixed sizes.
   */
  sizing: z
    .object({
      leverage: z.number().nonnegative().default(0),
      levelFraction: z.number().gt(0).max(1).default(0.33),
      /** Re-derive the sizes only when equity moved by more than this fraction since the last time (avoids churn). */
      rebalanceTol: z.number().positive().default(0.1),
    })
    .default({}),

  /** Gas pricing for the cost controls. Gas is paid in APT; the bot needs its dollar value to weigh it against edge. */
  gas: z
    .object({
      /** Poll public APT/USD quotes (Coinbase, Kraken, ...). Without a price gas is not weighed in the controllers. */
      priceFeed: z.boolean().default(true),
      /** USD per APT to use when no quote is available; 0 = unknown. */
      aptUsdFallback: z.number().nonnegative().default(0),
      /** APT per transaction to assume until enough transactions were observed. */
      assumedAptPerTx: z.number().positive().default(0.0006),
    })
    .default({}),

  /** Volatility circuit breaker; see strategy/fuse.ts. */
  fuse: z
    .object({
      enabled: z.boolean().default(true),
      fastMoveBps: z.number().positive().default(15),
      fastWindowMs: z.number().int().positive().default(5_000),
      slowMoveBps: z.number().positive().default(40),
      slowWindowMs: z.number().int().positive().default(60_000),
      spreadBps: z.number().positive().default(10),
      oracleDevBps: z.number().positive().default(15),
      cooldownMs: z.number().int().positive().default(60_000),
      maxCooldownMs: z.number().int().positive().default(1_800_000),
      recoverMs: z.number().int().positive().default(300_000),
      recoverWiden: z.number().min(1).default(2),
      haltAfterTripsPerHour: z.number().int().positive().default(6),
      /**
       * What too many trips mean: "halt" ends the process (a human restarts it), "cooloff" pulls quotes for
       * `cooloffMs`, forgets the trips and carries on (wider for a while). Unattended runs use "cooloff".
       */
      haltMode: z.enum(["halt", "cooloff"]).default("halt"),
      cooloffMs: z.number().int().positive().default(3_600_000),
      toxicFills: z.number().int().positive().default(5),
      toxicMarkoutBps: z.number().positive().default(3),
    })
    .default({}),

  /** Staged size ramp; the market sizes are the FINAL sizes. See strategy/ramp.ts. */
  ramp: z
    .object({
      enabled: z.boolean().default(true),
      stages: z.array(z.number().positive().max(1)).min(1).default([0.5, 1]),
      minStageMs: z.number().int().positive().default(4 * 3_600_000),
      minStageFills: z.number().int().nonnegative().default(20),
      maxStageLossPct: z.number().positive().default(3),
      maxStageTrips: z.number().int().nonnegative().default(0),
    })
    .default({}),

  /**
   * Decibel's Maker Rebate campaign: 0.5 bps on bulk-order maker fill volume for accounts whose maker
   * ratio is at least 80 % over a half-month cycle (1st-15th, 16th-end), perp and spot judged separately.
   */
  rebate: z
    .object({
      enabled: z.boolean().default(true),
      bps: z.number().nonnegative().default(0.5),
      minMakerRatio: z.number().min(0).max(1).default(0.8),
      /** Keep the cycle maker ratio at least this far above the threshold; below it, taker reduces are held back. */
      ratioBuffer: z.number().min(0).max(0.5).default(0.05),
    })
    .default({}),

  /** Competing for queue priority with other bots. */
  competition: z
    .object({
      joinTouch: z.boolean().default(true),
      improveTicks: z.number().int().nonnegative().default(0),
      /** Fallback fee if the venue does not report it. */
      makerFeeBps: z.number().nonnegative().default(1.5),
      /**
       * Quotes stay this many ticks away from the opposite touch (0 = may sit right at it). A quote that the book
       * reaches before the transaction lands can execute as a taker, which costs the taker fee and the maker ratio.
       */
      touchGuardTicks: z.number().int().min(0).default(0),
      /**
       * Raise the guard by itself: one extra tick for every `crossesPerTick` resting-order taker fills in the last
       * hour, up to `maxGuardTicks`. 0 = off.
       */
      crossesPerTick: z.number().int().min(0).default(3),
      maxGuardTicks: z.number().int().min(0).default(2),
    })
    .default({}),

  /** How transactions are submitted. */
  execution: z
    .object({
      /**
       * "auto": submit encrypted (hidden from front-runners) when the node supports it, else plain.
       * "on": same but warn loudly when unsupported. "off": never encrypt.
       */
      encrypted: z.enum(["auto", "on", "off"]).default("auto"),
    })
    .default({}),

  live: z
    .object({
      /** "auto" detects units from the oracle price; set explicitly if detection reports ambiguity. */
      priceUnits: z.enum(["auto", "human", "chain"]).default("auto"),
      sizeUnits: z.enum(["auto", "human", "chain"]).default("auto"),
    })
    .default({}),

  /** Paper-trading simulation knobs. */
  paper: z
    .object({
      startMid: z.number().positive().default(60_000),
      annualVolPct: z.number().positive().default(55),
      marketHalfSpreadBps: z.number().positive().default(0.8),
      /** Expected taker events per second that reach the touch. */
      flowPerSec: z.number().positive().default(2),
      makerFeeBps: z.number().default(1.1),
      takerFeeBps: z.number().default(3.4),
      equityUsd: z.number().positive().default(5_000),
      /** Gas per transaction in APT; 0 = the simulated venue reports no gas. */
      gasAptPerTx: z.number().nonnegative().default(0),
      seed: z.number().int().default(42),
      /** Optional price shock for testing the fuse: jump `shockPct` percent at `shockAtSec`. */
      shockAtSec: z.number().nonnegative().optional(),
      shockPct: z.number().default(0),
      /** Optional volatility burst: volatility is multiplied by `burstMult` for `burstSec` from `burstAtSec`. */
      burstAtSec: z.number().nonnegative().optional(),
      burstSec: z.number().positive().default(600),
      burstMult: z.number().positive().default(20),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
export type MarketConfig = Config["markets"][number];

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return configSchema.parse(raw);
}

/** Secrets and addresses come from the environment, never from the config file. */
export interface LiveEnv {
  nodeApiKey: string;
  /** Hex private key of the signing (ideally delegated, trade-only) account. */
  privateKey: string;
  /** Trading subaccount that holds collateral and positions. */
  subaccount: string;
  /** Owner wallet of the subaccount; Amps/streak are aggregated per owner. */
  owner: string;
}

export function loadLiveEnv(env: NodeJS.ProcessEnv = process.env): LiveEnv {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing environment variable ${k}`);
    return v;
  };
  return {
    nodeApiKey: need("APTOS_NODE_API_KEY"),
    privateKey: need("MM_PRIVATE_KEY"),
    subaccount: need("MM_SUBACCOUNT"),
    owner: need("MM_OWNER"),
  };
}
