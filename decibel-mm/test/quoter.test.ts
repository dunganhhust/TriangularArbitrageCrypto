import { describe, expect, it } from "vitest";
import { buildLadder, isLadderThreatened, microprice, needsReplace, stripOwn } from "../src/strategy/quoter.js";
import type { QuoteParams } from "../src/strategy/quoter.js";
import type { Book, MarketSpec } from "../src/types.js";

const spec: MarketSpec = { name: "BTC-USD", addr: "0x1", pxDecimals: 1, szDecimals: 4, tickSize: 0.1, lotSize: 0.0001, minSize: 0.001 };
const params: QuoteParams = {
  levels: 3, baseHalfSpreadBps: 2, levelStepBps: 1.5, levelSizeUsd: 100, sizeGrowth: 1,
  inventorySkewBps: 6, maxPositionUsd: 500, minHalfSpreadBps: 0.5, spreadMult: 1, volBps: 0, volK: 0,
};
const book = (bid: number, ask: number): Book => ({ bids: [{ price: bid, size: 1 }], asks: [{ price: ask, size: 1 }], ts: 0 });

describe("buildLadder", () => {
  it("quotes symmetric, tick-aligned, strictly ordered levels around fair", () => {
    const l = buildLadder({ spec, fair: 60000, position: 0, book: null, params });
    expect(l.bids).toHaveLength(3);
    expect(l.asks).toHaveLength(3);
    expect(l.bids[0]!.price).toBeCloseTo(59988, 1); // 2 bps below
    expect(l.asks[0]!.price).toBeCloseTo(60012, 1);
    for (const q of [...l.bids, ...l.asks]) expect(Math.abs(q.price / 0.1 - Math.round(q.price / 0.1))).toBeLessThan(1e-6);
    for (let i = 1; i < 3; i++) {
      expect(l.bids[i]!.price).toBeLessThan(l.bids[i - 1]!.price);
      expect(l.asks[i]!.price).toBeGreaterThan(l.asks[i - 1]!.price);
    }
  });

  it("never crosses the touch even when the target is inside it", () => {
    const tight = { ...params, baseHalfSpreadBps: 0, minHalfSpreadBps: 0 };
    const l = buildLadder({ spec, fair: 60000, position: 0, book: book(59999.9, 60000.1), params: tight });
    expect(l.bids[0]!.price).toBeLessThanOrEqual(60000.0);
    expect(l.asks[0]!.price).toBeGreaterThanOrEqual(60000.0);
    expect(l.bids[0]!.price).toBeLessThan(l.asks[0]!.price);
  });

  it("skews against inventory: long position lowers both sides", () => {
    const flat = buildLadder({ spec, fair: 60000, position: 0, book: null, params });
    const long = buildLadder({ spec, fair: 60000, position: 250 / 60000, book: null, params });
    expect(long.bids[0]!.price).toBeLessThan(flat.bids[0]!.price);
    expect(long.asks[0]!.price).toBeLessThan(flat.asks[0]!.price);
  });

  it("goes one-sided at the position limit and caps total exposure", () => {
    const atLimit = buildLadder({ spec, fair: 60000, position: 500 / 60000, book: null, params });
    expect(atLimit.bids).toHaveLength(0);
    expect(atLimit.asks.length).toBeGreaterThan(0);
    const near = buildLadder({ spec, fair: 60000, position: 450 / 60000, book: null, params: { ...params, levelSizeUsd: 100 } });
    const buyUsd = near.bids.reduce((a, q) => a + q.price * q.size, 0);
    expect(buyUsd).toBeLessThanOrEqual(50 + 1);
  });

  it("drops levels below the minimum size", () => {
    const l = buildLadder({ spec, fair: 60000, position: 0, book: null, params: { ...params, levelSizeUsd: 10 } });
    expect(l.bids).toHaveLength(0); // 10 USD / 60000 = 0.000166 < 0.001
  });

  it("widens with spreadMult and volatility", () => {
    const base = buildLadder({ spec, fair: 60000, position: 0, book: null, params });
    const wide = buildLadder({ spec, fair: 60000, position: 0, book: null, params: { ...params, spreadMult: 2 } });
    const vol = buildLadder({ spec, fair: 60000, position: 0, book: null, params: { ...params, volBps: 4, volK: 1 } });
    expect(wide.asks[0]!.price).toBeGreaterThan(base.asks[0]!.price);
    expect(vol.asks[0]!.price).toBeGreaterThan(base.asks[0]!.price);
  });

  it("treats minHalfSpreadBps as a true floor even when spreadMult < 1", () => {
    const p = { ...params, baseHalfSpreadBps: 2, minHalfSpreadBps: 1.5, spreadMult: 0.5, levels: 1 };
    const l = buildLadder({ spec, fair: 60000, position: 0, book: null, params: p });
    // 1.5 bps of 60000 = 9; bid must be at or below 59991, ask at or above 60009.
    expect(l.bids[0]!.price).toBeLessThanOrEqual(59991);
    expect(l.asks[0]!.price).toBeGreaterThanOrEqual(60009);
  });

  it("returns nothing without a price", () => {
    expect(buildLadder({ spec, fair: 0, position: 0, book: null, params })).toEqual({ bids: [], asks: [] });
  });
});

describe("book helpers", () => {
  it("microprice leans toward the thinner side", () => {
    const b: Book = { bids: [{ price: 100, size: 9 }], asks: [{ price: 102, size: 1 }], ts: 0 };
    expect(microprice(b)).toBeCloseTo(101.8, 6);
  });

  it("stripOwn removes our resting size and drops emptied levels", () => {
    const b: Book = { bids: [{ price: 100, size: 1 }, { price: 99, size: 2 }], asks: [{ price: 101, size: 0.5 }], ts: 0 };
    const out = stripOwn(b, { bids: [{ price: 100, size: 1 }], asks: [{ price: 101, size: 0.25 }] })!;
    expect(out.bids).toEqual([{ price: 99, size: 2 }]);
    expect(out.asks).toEqual([{ price: 101, size: 0.25 }]);
  });

  it("needsReplace ignores noise and reacts to drift or size change", () => {
    const t = buildLadder({ spec, fair: 60000, position: 0, book: null, params });
    const rules = { repriceBps: 1, sizeTol: 0.15 };
    expect(needsReplace(null, t, rules)).toBe(true);
    expect(needsReplace(t, t, rules)).toBe(false);
    const drift = buildLadder({ spec, fair: 60010, position: 0, book: null, params });
    expect(needsReplace(t, drift, rules)).toBe(true);
    const noise = buildLadder({ spec, fair: 60001, position: 0, book: null, params });
    expect(needsReplace(t, noise, rules)).toBe(false);
  });

  it("flags a ladder only when the market has reached or passed it", () => {
    const live = { bids: [{ price: 100, size: 1 }], asks: [{ price: 101, size: 1 }] };
    expect(isLadderThreatened(live, book(98, 99.9), 0)).toBe(true); // ask fell through our bid
    expect(isLadderThreatened(live, book(101.5, 102), 0)).toBe(true); // bid rose through our ask
    expect(isLadderThreatened(live, book(99.5, 101.5), 0)).toBe(false);
    // Quotes hugging the touch of a tight market are normal, not threatened.
    expect(isLadderThreatened(live, book(99.99, 100.001), 0)).toBe(false);
    // Tolerance widens the trigger.
    expect(isLadderThreatened(live, book(99.99, 100.001), 0.3)).toBe(true);
  });
});
