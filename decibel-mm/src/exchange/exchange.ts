import type { AccountInfo, Book, Fill, Ladder, MarketSpec, PointsSnapshot, PriceInfo } from "../types.js";

export interface ReduceRequest {
  market: string;
  side: "buy" | "sell";
  /** Base-asset size to close (human units). */
  size: number;
  /** Worst acceptable price (human). */
  limitPrice: number;
}

export interface GasStats {
  /** Transactions this process has submitted. */
  txCount: number;
  /** Gas spent by this process, in APT. */
  gasApt: number;
  /** Current APT balance of the signing account (it pays gas), if known. */
  balanceApt: number | null;
  /** Gas and transaction counts split by submission path (encrypted / plain), where the venue knows them. */
  byPath?: Record<"encrypted" | "plain", { tx: number; gasApt: number; unitPrice: number | null; avgApt: number | null }>;
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

  /** Optional maker/taker fee rates (decimals, e.g. 0.00015). */
  getFees?(): { maker: number; taker: number } | null;

  /** Optional: how long ago positions and the account were last read successfully (null = never). */
  dataAge?(): { positionsMs: number | null; accountMs: number | null };

  /** Optional: markets that still have quotes resting on the venue, e.g. left behind by a crashed process. */
  listResting?(): Promise<string[]>;

  /** Optional gas telemetry for venues where the signer pays gas. */
  getGas?(): GasStats | null;

  /** Optional points/fee telemetry; null when not available. */
  getPoints?(): Promise<PointsSnapshot | null>;
}
