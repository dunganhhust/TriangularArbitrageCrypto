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
      volWindowMs: z.number().int().positive().default(60_000),
      stateFile: z.string().default("state/state.json"),
      killSwitchFile: z.string().default("state/KILL"),
      pointsLogFile: z.string().default("data/points_log.csv"),
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
