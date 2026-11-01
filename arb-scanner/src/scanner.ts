import { mid, vwap } from "./book.js";
import type { Book, Funding, VenueFees } from "./types.js";

export interface CrossOpp {
  buyPx: number;
  sellPx: number;
  grossBps: number;
  netBps: number;
  notionalUsd: number;
}

/**
 * Buy on A (take asks) and sell on B (take bids) at `notionalUsd`, both as takers.
 * `extraBps` is the allowance for the price moving while the two orders travel (latency and slippage).
 * Returns null when either book cannot fill the size.
 */
export function crossOpp(a: Book, b: Book, feesA: VenueFees, feesB: VenueFees, notionalUsd: number, extraBps: number): CrossOpp | null {
  const ma = mid(a);
  const mb = mid(b);
  if (ma === null || mb === null) return null;
  const ref = (ma + mb) / 2;
  const size = notionalUsd / ref;
  const buyPx = vwap(a.asks, size);
  const sellPx = vwap(b.bids, size);
  if (buyPx === null || sellPx === null) return null;
  const grossBps = ((sellPx - buyPx) / ref) * 1e4;
  return { buyPx, sellPx, grossBps, netBps: grossBps - feesA.takerBps - feesB.takerBps - extraBps, notionalUsd };
}

export interface FundingEdge {
  /** Venue to go long on (pays the lower funding). */
  longOn: string;
  shortOn: string;
  /** Funding difference earned per day, in bps of notional. */
  bpsPerDay: number;
  aprPct: number;
  /** Carry over the holding period minus the cost of opening and closing both legs as takers. */
  netBpsOverHold: number;
  breakEvenDays: number;
}

export function fundingEdge(nameA: string, fa: Funding, feesA: VenueFees, nameB: string, fb: Funding, feesB: VenueFees, holdDays: number): FundingEdge {
  const diffPerHour = fb.ratePerHour - fa.ratePerHour; // long A, short B earns B's rate and pays A's
  const longA = diffPerHour >= 0;
  const bpsPerDay = Math.abs(diffPerHour) * 24 * 1e4;
  const roundTripBps = 2 * (feesA.takerBps + feesB.takerBps);
  return {
    longOn: longA ? nameA : nameB,
    shortOn: longA ? nameB : nameA,
    bpsPerDay,
    aprPct: (bpsPerDay * 365) / 100,
    netBpsOverHold: bpsPerDay * holdDays - roundTripBps,
    breakEvenDays: bpsPerDay > 0 ? roundTripBps / bpsPerDay : Infinity,
  };
}

export interface ClosedOpp {
  key: string;
  startedAt: number;
  durationMs: number;
  maxNetBps: number;
  samples: number;
}

/** Follows each opportunity key while its net edge stays above the threshold, and reports it when it ends. */
export class OppTracker {
  private open = new Map<string, { startedAt: number; lastSeen: number; maxNetBps: number; samples: number }>();
  constructor(
    private readonly minNetBps: number,
    private readonly graceMs: number,
    private readonly onClose: (c: ClosedOpp) => void,
  ) {}

  update(key: string, netBps: number | null, now: number): void {
    const cur = this.open.get(key);
    if (netBps !== null && netBps > this.minNetBps) {
      if (cur) {
        cur.lastSeen = now;
        cur.maxNetBps = Math.max(cur.maxNetBps, netBps);
        cur.samples++;
      } else this.open.set(key, { startedAt: now, lastSeen: now, maxNetBps: netBps, samples: 1 });
    } else if (cur && now - cur.lastSeen >= this.graceMs) this.close(key, cur);
  }

  /** Close everything still open (on shutdown). */
  flush(): void {
    for (const [k, v] of this.open) this.close(k, v);
  }

  get openCount(): number {
    return this.open.size;
  }

  private close(key: string, cur: { startedAt: number; lastSeen: number; maxNetBps: number; samples: number }): void {
    this.open.delete(key);
    this.onClose({ key, startedAt: cur.startedAt, durationMs: cur.lastSeen - cur.startedAt, maxNetBps: cur.maxNetBps, samples: cur.samples });
  }
}
