import type { Book, Ladder, MarketSpec, Quote } from "../types.js";

export interface QuoteParams {
  levels: number;
  /** Distance of the first level from the reservation price. */
  baseHalfSpreadBps: number;
  /** Extra distance added per additional level. */
  levelStepBps: number;
  /** Notional of the first level, per side. */
  levelSizeUsd: number;
  /** Size multiplier per deeper level (1 = flat). */
  sizeGrowth: number;
  /** Reservation-price shift (bps) when inventory is at +/- maxPositionUsd. */
  inventorySkewBps: number;
  maxPositionUsd: number;
  /** Hard floor on the half spread; keep above the maker fee unless farming on purpose. */
  minHalfSpreadBps: number;
  /** Multiplier on the half spread; driven by the points controller. */
  spreadMult: number;
  /** Short-horizon volatility estimate in bps; widens quotes. */
  volBps: number;
  volK: number;
  /** Optional touch competition; see {@link buildLadder}. */
  competition?: CompetitionParams;
}

export interface CompetitionParams {
  /** Rest at the best bid/ask (ex our own orders) when that is affordable. */
  joinTouch: boolean;
  /** Ticks to improve on the touch by (0 = join it). Only when the spread leaves room. */
  improveTicks: number;
  /** Our maker fee, bps. */
  makerFeeBps: number;
  /** Net cost per fill (bps, after the fee) we accept in order to sit at the touch. */
  maxCostBps: number;
}

export interface QuoteInput {
  spec: MarketSpec;
  /** Fair value; use microprice/oracle blend, not raw mid, where possible. */
  fair: number;
  /** Signed base-asset position. */
  position: number;
  book: Book | null;
  params: QuoteParams;
}

const EPS = 1e-9;

export function roundDownToStep(x: number, step: number): number {
  return Math.floor(x / step + EPS) * step;
}
export function roundUpToStep(x: number, step: number): number {
  return Math.ceil(x / step - EPS) * step;
}
/** Remove float noise left over from step multiplication. */
function clean(x: number, decimals: number): number {
  return Number(x.toFixed(decimals));
}

/**
 * Remove our own resting size from the book so fair value and touch clamps are not
 * computed from our own quotes (otherwise quotes anchor to themselves and drift).
 */
export function stripOwn(book: Book | null, live: Ladder | null): Book | null {
  if (!book || !live) return book;
  const strip = (levels: Book["bids"], mine: Quote[]): Book["bids"] => {
    const m = new Map(mine.map((q) => [q.price, q.size]));
    return levels
      .map((l) => ({ price: l.price, size: l.size - (m.get(l.price) ?? 0) }))
      .filter((l) => l.size > 1e-12);
  };
  return { bids: strip(book.bids, live.bids), asks: strip(book.asks, live.asks), ts: book.ts };
}

/** Size-weighted mid of the top of book; falls back to plain mid. */
export function microprice(book: Book | null): number | null {
  const b = book?.bids[0];
  const a = book?.asks[0];
  if (!b || !a) return null;
  const tot = b.size + a.size;
  if (tot <= 0) return (a.price + b.price) / 2;
  return (b.price * a.size + a.price * b.size) / tot;
}

/**
 * Pure quote construction.
 *
 * Reservation price is shifted against inventory (long -> lower both sides, so asks fill
 * first). Size on the exposure-increasing side is capped by the remaining capacity up to
 * `maxPositionUsd`, which degrades gracefully to one-sided quoting at the limit.
 * Bids are rounded down and asks up so rounding never makes a quote more aggressive, and
 * both sides are clamped to stay behind the touch (never cross the book).
 */
export function buildLadder(inp: QuoteInput): Ladder {
  const { spec, fair, position, book, params: p } = inp;
  if (!(fair > 0)) return { bids: [], asks: [] };

  const posUsd = position * fair;
  const invRatio = Math.max(-1, Math.min(1, p.maxPositionUsd > 0 ? posUsd / p.maxPositionUsd : 0));
  const reservation = fair * (1 - (invRatio * p.inventorySkewBps) / 1e4);

  // The floor applies after the multiplier so spreadMult < 1 can never undercut minHalfSpreadBps.
  const half0 = Math.max(p.minHalfSpreadBps, (p.baseHalfSpreadBps + p.volK * p.volBps) * p.spreadMult);

  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  const maxBid = bestAsk !== undefined ? bestAsk - spec.tickSize : Infinity;
  const minAsk = bestBid !== undefined ? bestBid + spec.tickSize : 0;

  // Remaining exposure capacity per side (USD, never negative).
  let buyCap = Math.max(0, p.maxPositionUsd - posUsd);
  let sellCap = Math.max(0, p.maxPositionUsd + posUsd);

  const bids: Quote[] = [];
  const asks: Quote[] = [];
  let lastBid = Infinity;
  let lastAsk = 0;

  for (let i = 0; i < p.levels; i++) {
    const offset = (half0 + i * p.levelStepBps) / 1e4;
    const growth = Math.pow(p.sizeGrowth, i);

    let bidPx = roundDownToStep(Math.min(reservation * (1 - offset), maxBid), spec.tickSize);
    let askPx = roundUpToStep(Math.max(reservation * (1 + offset), minAsk), spec.tickSize);
    if (i === 0 && p.competition?.joinTouch) {
      const j = touchPrices(p.competition, spec, fair, book, invRatio);
      // Take the more aggressive of the spread-based price and the affordable touch price.
      if (j.bid !== null) bidPx = Math.max(bidPx, Math.min(j.bid, maxBid));
      if (j.ask !== null) askPx = Math.min(askPx, Math.max(j.ask, minAsk));
    }
    bidPx = Math.min(bidPx, lastBid - spec.tickSize);
    askPx = Math.max(askPx, lastAsk + spec.tickSize);
    // Never post an ask at or below our own bid (would self-match).
    if (bidPx > 0 && askPx <= bidPx) askPx = roundUpToStep(bidPx + spec.tickSize, spec.tickSize);

    if (bidPx > 0) {
      let sz = (p.levelSizeUsd * growth) / bidPx;
      sz = Math.min(sz, buyCap / bidPx);
      sz = roundDownToStep(sz, spec.lotSize);
      if (sz >= spec.minSize - EPS) {
        bids.push({ price: clean(bidPx, spec.pxDecimals), size: clean(sz, spec.szDecimals) });
        buyCap -= sz * bidPx;
      }
      lastBid = bidPx;
    }
    {
      let sz = (p.levelSizeUsd * growth) / askPx;
      sz = Math.min(sz, sellCap / askPx);
      sz = roundDownToStep(sz, spec.lotSize);
      if (sz >= spec.minSize - EPS) {
        asks.push({ price: clean(askPx, spec.pxDecimals), size: clean(sz, spec.szDecimals) });
        sellCap -= sz * askPx;
      }
      lastAsk = askPx;
    }
  }
  return { bids, asks };
}

export interface ReplaceRules {
  /** Replace when any level drifted by more than this (bps). */
  repriceBps: number;
  /** Replace when a level's size changed by more than this fraction. */
  sizeTol: number;
}

/** True when the live ladder is stale enough versus the target to justify a transaction. */
export function needsReplace(live: Ladder | null, target: Ladder, r: ReplaceRules): boolean {
  if (!live) return target.bids.length + target.asks.length > 0;
  return sideDiffers(live.bids, target.bids, r) || sideDiffers(live.asks, target.asks, r);
}

function sideDiffers(a: Quote[], b: Quote[], r: ReplaceRules): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (Math.abs(x.price - y.price) / y.price > r.repriceBps / 1e4) return true;
    if (Math.abs(x.size - y.size) > r.sizeTol * Math.max(y.size, 1e-12)) return true;
  }
  return false;
}

/**
 * A resting quote is threatened when the market has moved onto or through it (our bid at or above
 * the best ask, or our ask at or below the best bid), shifted by `thresholdBps` of tolerance.
 * A quote merely sitting at the touch of a tight market is normal and must not count: BTC spreads
 * are a fraction of a bp, so any maker quote is "close" to the opposite side all the time.
 */
export function isLadderThreatened(live: Ladder | null, book: Book | null, thresholdBps: number): boolean {
  if (!live || !book) return false;
  const bb = book.bids[0]?.price;
  const ba = book.asks[0]?.price;
  if (bb === undefined || ba === undefined) return false;
  const mid = (bb + ba) / 2;
  const topBid = live.bids[0]?.price;
  const topAsk = live.asks[0]?.price;
  if (topBid !== undefined && ((topBid - ba) / mid) * 1e4 >= -thresholdBps) return true;
  if (topAsk !== undefined && ((bb - topAsk) / mid) * 1e4 >= -thresholdBps) return true;
  return false;
}

/**
 * Prices at which we could rest at (or just inside) the touch without paying more than the cost
 * budget. Joining a bid at price b against fair value F earns (F - b)/F in bps before the fee; the
 * fee turns that negative in tight markets, which is the real price of queue priority. Joining is
 * refused on the side that would add to an inventory we are already leaning on.
 */
export function touchPrices(
  c: CompetitionParams,
  spec: MarketSpec,
  fair: number,
  book: Book | null,
  invRatio: number,
): { bid: number | null; ask: number | null } {
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  let bid: number | null = null;
  let ask: number | null = null;
  const room = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : 0;
  const improve = c.improveTicks > 0 && room >= (c.improveTicks + 2) * spec.tickSize ? c.improveTicks * spec.tickSize : 0;
  if (bestBid !== undefined && invRatio < 0.5) {
    const px = bestBid + improve;
    const edge = ((fair - px) / fair) * 1e4 - c.makerFeeBps;
    if (edge >= -c.maxCostBps) bid = px;
  }
  if (bestAsk !== undefined && invRatio > -0.5) {
    const px = bestAsk - improve;
    const edge = ((px - fair) / fair) * 1e4 - c.makerFeeBps;
    if (edge >= -c.maxCostBps) ask = px;
  }
  return { bid, ask };
}

/** Largest relative move (bps) of the best bid or best ask between two ladders. */
export function topDriftBps(live: Ladder | null, target: Ladder): number {
  if (!live) return 0;
  let worst = 0;
  const cmp = (a?: Quote, b?: Quote): void => {
    if (a && b && b.price > 0) worst = Math.max(worst, (Math.abs(a.price - b.price) / b.price) * 1e4);
  };
  cmp(live.bids[0], target.bids[0]);
  cmp(live.asks[0], target.asks[0]);
  return worst;
}
