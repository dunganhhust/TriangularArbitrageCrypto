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
      /** Randomise each refresh interval by +/- this fraction so the cadence is not predictable. */
      jitterPct: z.number().min(0).max(0.9).default(0.2),
      volWindowMs: z.number().int().positive().default(60_000),
      stateFile: z.string().default("state/state.json"),
      killSwitchFile: z.string().default("state/KILL"),
      pointsLogFile: z.string().default("data/points_log.csv"),
      /** Every log line of a live run is also appended here; the dashboard reads it. "" = off. */
      runLogFile: z.string().default("data/run.log"),
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
