import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { unitsFromOracle } from "../src/venues/decibel.js";
import { parseHlBook, parseHlFunding } from "../src/venues/hyperliquid.js";
import { LighterBookState, parseLighterFunding, parseLighterMarkets } from "../src/venues/lighter.js";

describe("hyperliquid parsers", () => {
  it("parses an l2Book message into sorted books", () => {
    const raw = JSON.stringify({ channel: "l2Book", data: { coin: "ETH", time: 5, levels: [[{ px: "2699.5", sz: "2", n: 1 }, { px: "2699.9", sz: "1", n: 1 }], [{ px: "2700.1", sz: "3", n: 2 }]] } });
    const p = parseHlBook(raw)!;
    expect(p.coin).toBe("ETH");
    expect(p.book.bids[0]).toEqual({ price: 2699.9, size: 1 });
    expect(p.book.asks[0]).toEqual({ price: 2700.1, size: 3 });
  });
  it("ignores other channels and junk", () => {
    expect(parseHlBook('{"channel":"subscriptionResponse"}')).toBeNull();
    expect(parseHlBook("nope")).toBeNull();
  });
  it("reads funding per hour from metaAndAssetCtxs", () => {
    const f = parseHlFunding([{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ funding: "0.0000125" }, { funding: "-0.00002" }]], 1);
    expect(f.get("BTC")!.ratePerHour).toBe(0.0000125);
    expect(f.get("ETH")!.ratePerHour).toBe(-0.00002);
  });
});

describe("lighter parsers", () => {
  it("applies a snapshot then deltas, removing zero-size levels", () => {
    const s = new LighterBookState();
    s.apply({ type: "subscribed/order_book", order_book: { bids: [{ price: "100", size: "1" }, { price: "99", size: "2" }], asks: [{ price: "101", size: "1" }] } });
    s.apply({ type: "update/order_book", order_book: { bids: [{ price: "100", size: "0" }], asks: [{ price: "100.5", size: "4" }] } });
    const b = s.toBook(0);
    expect(b.bids.map((l) => l.price)).toEqual([99]);
    expect(b.asks.map((l) => l.price)).toEqual([100.5, 101]);
  });
  it("a new snapshot replaces the old state; non-book messages are ignored", () => {
    const s = new LighterBookState();
    s.apply({ type: "subscribed/order_book", order_book: { bids: [{ price: "100", size: "1" }], asks: [] } });
    s.apply({ type: "subscribed/order_book", order_book: { bids: [{ price: "90", size: "1" }], asks: [] } });
    expect(s.toBook(0).bids.map((l) => l.price)).toEqual([90]);
    expect(s.apply({ type: "pong" })).toBe(false);
  });
  it("reads markets and funding rows", () => {
    expect(parseLighterMarkets({ order_books: [{ symbol: "ETH", market_id: 0 }, { symbol: "BTC", market_id: 1 }] }).get("BTC")).toBe(1);
    const f = parseLighterFunding({ funding_rates: [{ symbol: "ETH", exchange: "lighter", rate: 0.0001 }, { symbol: "ETH", exchange: "binance", rate: 0.5 }] }, 1);
    expect(f.get("ETH")!.ratePerHour).toBe(0.0001);
  });
});

describe("decibel units", () => {
  it("detects chain units from the oracle", () => {
    expect(unitsFromOracle([2_699_000_000], 2699, 6)).toBe("chain");
    expect(unitsFromOracle([2699.5], 2699, 6)).toBe("human");
  });
});

describe("config", () => {
  it("has working defaults", () => {
    const c = ConfigSchema.parse({});
    expect(c.symbols).toContain("ETH");
    expect(c.venues.hyperliquid.enabled).toBe(true);
  });
});

import { parseAsterDepth, parseAsterFunding, parseAsterIntervals } from "../src/venues/aster.js";
import { parseVariationalFunding } from "../src/venues/variational.js";

describe("aster parsers", () => {
  it("parses a wrapped partial-depth message", () => {
    const raw = JSON.stringify({ stream: "ethusdt@depth20@100ms", data: { e: "depthUpdate", s: "ETHUSDT", b: [["2699.5", "2"], ["2699.9", "1"]], a: [["2700.1", "3"]] } });
    const p = parseAsterDepth(raw, 7)!;
    expect(p.symbol).toBe("ETHUSDT");
    expect(p.book.bids[0]).toEqual({ price: 2699.9, size: 1 });
    expect(p.book.ts).toBe(7);
    expect(parseAsterDepth('{"result":null}', 0)).toBeNull();
  });
  it("converts funding to per hour using each symbol's interval", () => {
    const iv = parseAsterIntervals([{ symbol: "ZORAUSDT", fundingIntervalHours: 4 }]);
    const f = parseAsterFunding([{ symbol: "ETHUSDT", lastFundingRate: "0.0008" }, { symbol: "ZORAUSDT", lastFundingRate: "0.0008" }], iv, 1);
    expect(f.get("ETHUSDT")!.ratePerHour).toBeCloseTo(0.0001, 10);
    expect(f.get("ZORAUSDT")!.ratePerHour).toBeCloseTo(0.0002, 10);
  });
});

describe("variational parser", () => {
  it("reads perpetual funding per hour and skips swaps and null funding", () => {
    const f = parseVariationalFunding(
      { listings: [
        { ticker: "BTC-PERP", contract_type: "perpetual", funding: { last: { interval_rate: "0.00008246" }, interval_seconds: 28800 } },
        { ticker: "XAU-SWAP", contract_type: "swap", funding: { last: { interval_rate: "0.1" }, interval_seconds: 86400 } },
        { ticker: "NEW-PERP", contract_type: "perpetual", funding: null },
      ] },
      1,
    );
    expect(f.get("BTC-PERP")!.ratePerHour).toBeCloseTo(0.00008246 / 8, 12);
    expect(f.size).toBe(1);
  });
});
