import type { Book, PriceInfo } from "../types.js";

export interface RiskConfig {
  /** Book older than this is treated as dead. */
  staleBookMs: number;
  /** Pause when the book mid and oracle diverge by more than this. */
  maxOracleDevBps: number;
  /** Pause when the spread is wider than this (illiquid/halted). */
  maxSpreadBps: number;
  /** Position beyond this (USD) triggers a taker reduce back to `reduceToUsd`. */
  emergencyPositionUsd: number;
  reduceToUsd: number;
  /** Stop everything when equity drops this far (USD) below the session-start equity. */
  maxDrawdownUsd: number;
  /** Consecutive failed transactions before a cool-down. */
  maxConsecutiveFailures: number;
  cooldownMs: number;
}

export type RiskAction =
  | { kind: "quote" }
  | { kind: "pause"; reason: string }
  | { kind: "reduce"; reason: string; side: "buy" | "sell"; sizeUsd: number }
  | { kind: "halt"; reason: string };

export interface RiskInput {
  now: number;
  book: Book | null;
  price: PriceInfo | null;
  positionUsd: number;
  equityUsd: number | null;
  startEquityUsd: number | null;
  consecutiveFailures: number;
  cooldownUntil: number;
  killSwitch: boolean;
}

export function assess(cfg: RiskConfig, i: RiskInput): RiskAction {
  if (i.killSwitch) return { kind: "halt", reason: "kill switch" };
  if (i.equityUsd !== null && i.startEquityUsd !== null && i.startEquityUsd - i.equityUsd > cfg.maxDrawdownUsd) {
    return { kind: "halt", reason: `drawdown ${(i.startEquityUsd - i.equityUsd).toFixed(2)} USD > limit` };
  }
  if (i.now < i.cooldownUntil) return { kind: "pause", reason: "tx cool-down" };

  const b = i.book;
  if (!b || !b.bids[0] || !b.asks[0]) return { kind: "pause", reason: "empty book" };
  if (i.now - b.ts > cfg.staleBookMs) return { kind: "pause", reason: "stale book" };
  const bid = b.bids[0].price;
  const ask = b.asks[0].price;
  if (bid >= ask) return { kind: "pause", reason: "crossed book" };
  const mid = (bid + ask) / 2;
  if (((ask - bid) / mid) * 1e4 > cfg.maxSpreadBps) return { kind: "pause", reason: "spread too wide" };
  if (i.price && i.price.oracle > 0 && (Math.abs(mid - i.price.oracle) / i.price.oracle) * 1e4 > cfg.maxOracleDevBps) {
    return { kind: "pause", reason: "mid/oracle divergence" };
  }
  if (Math.abs(i.positionUsd) > cfg.emergencyPositionUsd) {
    return {
      kind: "reduce",
      reason: `position ${i.positionUsd.toFixed(0)} USD beyond emergency limit`,
      side: i.positionUsd > 0 ? "sell" : "buy",
      sizeUsd: Math.abs(i.positionUsd) - cfg.reduceToUsd,
    };
  }
  return { kind: "quote" };
}
