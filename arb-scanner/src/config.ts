import { readFileSync } from "node:fs";
import { z } from "zod";

const fees = z.object({ makerBps: z.number().nonnegative(), takerBps: z.number().nonnegative() });

const venue = z.object({
  enabled: z.boolean().default(true),
  fees: fees.optional(),
  /** Common symbol -> this venue's own name. */
  symbolMap: z.record(z.string()).default({}),
  url: z.string().optional(),
});

export const ConfigSchema = z.object({
  symbols: z.array(z.string()).min(1).default(["ETH", "BTC"]),
  /** Order sizes (USD) at which each pair is evaluated. */
  notionalUsd: z.array(z.number().positive()).min(1).default([50, 200]),
  /** Allowance for adverse price movement while the two orders travel, in bps. */
  extraBps: z.number().nonnegative().default(0.5),
  /** An opportunity is counted while its net edge stays above this. */
  minNetBps: z.number().default(0),
  /** An opportunity ends when it has been below the threshold this long. */
  graceMs: z.number().int().positive().default(1000),
  /** Books older than this are ignored. */
  maxBookAgeMs: z.number().int().positive().default(3000),
  scanIntervalMs: z.number().int().positive().default(200),
  statusEveryMs: z.number().int().positive().default(15_000),
  fundingEveryMs: z.number().int().positive().default(60_000),
  /** Days a funding position would be held, for the carry-versus-fees figure. */
  holdDays: z.number().positive().default(3),
  logFile: z.string().default("data/opps.jsonl"),
  fundingFile: z.string().default("data/funding.jsonl"),
  venues: z
    .object({
      hyperliquid: venue.default({}),
      lighter: venue.default({}),
      decibel: venue.default({}),
      aster: venue.default({}),
      variational: venue.default({}),
      /** trade.xyz: HIP-3 markets on Hyperliquid (use symbolMap, e.g. {"TSLA": "xyz:TSLA"}). Off until verified. */
      tradexyz: venue.default({ enabled: false }),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path?: string): Config {
  if (!path) return ConfigSchema.parse({});
  return ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
