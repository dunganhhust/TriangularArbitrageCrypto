import { describe, expect, it } from "vitest";
import { depthUsd, mid, normalize, vwap } from "../src/book.js";
import { crossOpp, fundingEdge, OppTracker } from "../src/scanner.js";
import type { ClosedOpp } from "../src/scanner.js";
import type { Book } from "../src/types.js";

const book = (bid: number, ask: number, size = 10): Book => normalize([{ price: bid, size }, { price: bid - 1, size }], [{ price: ask, size }, { price: ask + 1, size }], 0);
const fee = { makerBps: 1, takerBps: 4 };

describe("book math", () => {
  it("sorts, drops empties and computes mid", () => {
    const b = normalize([{ price: 99, size: 1 }, { price: 100, size: 1 }, { price: 101, size: 0 }], [{ price: 102, size: 1 }, { price: 101.5, size: 1 }], 1);
    expect(b.bids.map((l) => l.price)).toEqual([100, 99]);
    expect(b.asks.map((l) => l.price)).toEqual([101.5, 102]);
    expect(mid(b)).toBe(100.75);
  });
  it("vwap walks levels and returns null when too thin", () => {
    const asks = [{ price: 100, size: 1 }, { price: 102, size: 1 }];
    expect(vwap(asks, 1)).toBe(100);
    expect(vwap(asks, 2)).toBe(101);
    expect(vwap(asks, 3)).toBeNull();
    expect(depthUsd(asks, 1)).toBe(100);
  });
});

describe("crossOpp", () => {
  it("finds a profitable route net of both taker fees and the allowance", () => {
    const a = book(99.9, 100); // cheap
    const b = book(100.4, 100.5); // dear
    const o = crossOpp(a, b, fee, fee, 50, 0.5)!;
    expect(o.buyPx).toBe(100);
    expect(o.sellPx).toBe(100.4);
    expect(o.grossBps).toBeCloseTo(((100.4 - 100) / 100.2) * 1e4, 1);
    expect(o.netBps).toBeCloseTo(o.grossBps - 8 - 0.5, 6);
  });
  it("is negative on the reverse route and null on thin books", () => {
    const a = book(99.9, 100);
    const b = book(100.4, 100.5);
    expect(crossOpp(b, a, fee, fee, 50, 0)!.netBps).toBeLessThan(0);
    expect(crossOpp(a, b, fee, fee, 1e9, 0)).toBeNull();
  });
});

describe("fundingEdge", () => {
  it("goes long the venue with the lower funding and counts round-trip fees", () => {
    const e = fundingEdge("A", { ratePerHour: 0.00001, ts: 0 }, fee, "B", { ratePerHour: 0.00005, ts: 0 }, fee, 5);
    expect(e.longOn).toBe("A");
    expect(e.shortOn).toBe("B");
    expect(e.bpsPerDay).toBeCloseTo(0.00004 * 24 * 1e4, 6); // 9.6
    expect(e.netBpsOverHold).toBeCloseTo(9.6 * 5 - 16, 6);
    expect(e.breakEvenDays).toBeCloseTo(16 / 9.6, 6);
  });
  it("flips direction when the rates swap", () => {
    const e = fundingEdge("A", { ratePerHour: 0.0001, ts: 0 }, fee, "B", { ratePerHour: 0, ts: 0 }, fee, 1);
    expect(e.longOn).toBe("B");
  });
});

describe("OppTracker", () => {
  it("reports an opportunity once it stays below the threshold for the grace period", () => {
    const closed: ClosedOpp[] = [];
    const t = new OppTracker(0, 1000, (c) => closed.push(c));
    t.update("k", 2, 0);
    t.update("k", 5, 300);
    t.update("k", -1, 600); // within grace
    expect(closed).toHaveLength(0);
    t.update("k", -1, 1400);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ key: "k", startedAt: 0, durationMs: 300, maxNetBps: 5, samples: 2 });
    expect(t.openCount).toBe(0);
  });
  it("flush closes what is still open", () => {
    const closed: ClosedOpp[] = [];
    const t = new OppTracker(0, 1000, (c) => closed.push(c));
    t.update("k", 1, 0);
    t.flush();
    expect(closed).toHaveLength(1);
  });
});
