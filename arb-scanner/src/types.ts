export interface Level {
  price: number;
  /** Base-asset size. */
  size: number;
}

export interface Book {
  /** Best first. */
  bids: Level[];
  /** Best first. */
  asks: Level[];
  ts: number;
}

export interface Funding {
  /** Funding rate as a fraction per hour; positive = longs pay shorts. */
  ratePerHour: number;
  ts: number;
}

export interface VenueFees {
  makerBps: number;
  takerBps: number;
}

export interface Venue {
  readonly name: string;
  readonly fees: VenueFees;
  /** Start streaming the given common symbols (e.g. "ETH"). Symbols the venue does not list are skipped. */
  start(symbols: string[]): Promise<void>;
  stop(): void;
  book(symbol: string): Book | null;
  funding(symbol: string): Funding | null;
  /** Symbols actually streaming. */
  symbols(): string[];
  /** Raw wire samples for the probe command. */
  samples?: string[];
}

export type Log = (msg: string, extra?: Record<string, unknown>) => void;
