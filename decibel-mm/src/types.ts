/** Domain types. All prices/sizes here are HUMAN units (USD per base, base units). */

export interface MarketSpec {
  name: string; // e.g. "BTC/USD" (mainnet names use a slash; `npm run check` lists them)
  addr: string;
  pxDecimals: number;
  szDecimals: number;
  tickSize: number; // human
  lotSize: number; // human
  minSize: number; // human
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface Book {
  bids: BookLevel[]; // best first
  asks: BookLevel[]; // best first
  ts: number; // ms
}

export interface Quote {
  price: number;
  size: number;
}

export interface Ladder {
  bids: Quote[]; // best (highest) first
  asks: Quote[]; // best (lowest) first
}

export type Side = "buy" | "sell";

export interface Fill {
  id: string;
  market: string;
  side: Side;
  price: number;
  size: number;
  /** Fee paid in USD; negative = rebate received. */
  feeUsd: number;
  isMaker: boolean;
  ts: number;
}

export interface PriceInfo {
  mark: number;
  mid: number;
  oracle: number;
  fundingBps: number; // signed, per funding period
  ts: number;
}

export interface AccountInfo {
  equityUsd: number;
  ts: number;
}

export interface PointsSnapshot {
  /** Amps credited for the current season day (UTC), if the API exposes it. */
  ampsToday: number | null;
  tradingAmpsToday: number | null;
  streakAmpsToday: number | null;
  currentStreak: number | null;
  tier: string | null;
  makerFeeRate: number | null; // decimal, e.g. 0.00011
  takerFeeRate: number | null;
  volume30dUsd: number | null;
  feeTier: number | null;
  /** Lifetime trading points for the owner (public endpoint; `tradingAmps` is internal-only). */
  totalPoints?: number | null;
  /** Endpoints that failed (as opposed to returning empty data), for diagnostics. */
  unavailable?: string[];
}

export const notional = (price: number, size: number): number => price * size;
export const bps = (x: number): number => x * 1e4;
