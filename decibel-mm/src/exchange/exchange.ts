import type { AccountInfo, Book, Fill, Ladder, MarketSpec, PointsSnapshot, PriceInfo } from "../types.js";

export interface ReduceRequest {
  market: string;
  side: "buy" | "sell";
  /** Base-asset size to close (human units). */
  size: number;
  /** Worst acceptable price (human). */
  limitPrice: number;
}

/** What the market maker needs from a venue. Implemented by the live adapter and the simulator. */
export interface Exchange {
  /** Connect, load market specs, start streams. */
  init(marketNames: string[]): Promise<MarketSpec[]>;
  close(): Promise<void>;

  /** Latest cached view; never blocks on the network. */
  getBook(market: string): Book | null;
  getPrice(market: string): PriceInfo | null;
  /** Signed base position. */
  getPosition(market: string): number;
  getAccount(): AccountInfo | null;

  /** Fills received since the last call. */
  drainFills(): Fill[];

  /**
   * Atomically replace ALL resting quotes for `market` with `ladder`
   * (an empty ladder cancels everything). Resolves true when the venue accepted it.
   */
  replaceLadder(market: string, ladder: Ladder): Promise<boolean>;
  cancelAll(market: string): Promise<boolean>;
  /** Reduce-only IOC to cut inventory. */
  reduce(req: ReduceRequest): Promise<boolean>;

  /** Optional points/fee telemetry; null when not available. */
  getPoints?(): Promise<PointsSnapshot | null>;
}
