import type { Book, Level } from "./types.js";

export function mid(b: Book): number | null {
  const bid = b.bids[0];
  const ask = b.asks[0];
  return bid && ask ? (bid.price + ask.price) / 2 : null;
}

/** Average price of taking `size` base units from `levels` (best first), or null when the book is too thin. */
export function vwap(levels: Level[], size: number): number | null {
  if (!(size > 0)) return null;
  let left = size;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(left, l.size);
    cost += take * l.price;
    left -= take;
    if (left <= 1e-12) return cost / size;
  }
  return null;
}

/** USD that can be taken from the first `n` levels. */
export function depthUsd(levels: Level[], n: number): number {
  return levels.slice(0, n).reduce((a, l) => a + l.price * l.size, 0);
}

/** Sort and drop empty levels. */
export function normalize(bids: Level[], asks: Level[], ts: number): Book {
  const ok = (l: Level): boolean => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0;
  return { bids: bids.filter(ok).sort((a, b) => b.price - a.price), asks: asks.filter(ok).sort((a, b) => a.price - b.price), ts };
}
