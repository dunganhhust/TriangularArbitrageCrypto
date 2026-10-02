/** Fee helpers that do not depend on the Decibel SDK (so they are cheap to unit test). */

export interface InferredFee {
  /** Fee in USD; negative = rebate received. */
  feeUsd: number;
  isMaker: boolean;
}

/**
 * Work out the fee actually charged on a fill and whether it was a maker fill.
 *
 * The trade-history row carries `fee_amount` without documenting its scale (whole USD or USDC base
 * units), so try both and keep the one whose fee/notional lands closest to a known rate. Judging by
 * what was charged rather than by how we sent the order catches an order that crossed the book by
 * the time it was matched and so paid the taker fee.
 */
export function inferFee(
  raw: number | undefined,
  isRebate: boolean,
  notional: number,
  makerRate: number,
  takerRate: number,
): InferredFee | null {
  if (raw === undefined || !Number.isFinite(raw) || !(notional > 0)) return null;
  const abs = Math.abs(raw);
  if (abs === 0) return { feeUsd: 0, isMaker: true };
  const dist = (r: number, rate: number): number => (rate > 0 ? Math.abs(Math.log(r / rate)) : Infinity);
  let best: { scale: number; r: number; score: number } | null = null;
  for (const scale of [1, 1e-6]) {
    const r = (abs * scale) / notional;
    const score = Math.min(dist(r, makerRate), dist(r, takerRate));
    if (best === null || score < best.score) best = { scale, r, score };
  }
  if (best === null || !Number.isFinite(best.score)) return null;
  const feeUsd = (isRebate ? -1 : 1) * abs * best.scale;
  const isMaker = isRebate || dist(best.r, makerRate) <= dist(best.r, takerRate);
  return { feeUsd, isMaker };
}

export interface DailyVolume {
  volume: string;
  maker_volume: string;
  taker_volume: string;
}

/** Sum the fee-window volumes and the maker fraction the market-maker fee tier is judged on. */
export function feeWindow(days: DailyVolume[]): { totalUsd: number; makerUsd: number; takerUsd: number; makerFraction: number | null } {
  let totalUsd = 0;
  let makerUsd = 0;
  let takerUsd = 0;
  for (const d of days) {
    totalUsd += Number(d.volume) || 0;
    makerUsd += Number(d.maker_volume) || 0;
    takerUsd += Number(d.taker_volume) || 0;
  }
  const denom = makerUsd + takerUsd;
  return { totalUsd, makerUsd, takerUsd, makerFraction: denom > 0 ? makerUsd / denom : null };
}
