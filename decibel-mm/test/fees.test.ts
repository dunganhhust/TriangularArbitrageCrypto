import { describe, expect, it } from "vitest";
import { feeWindow, inferFee } from "../src/exchange/fees.js";

const MAKER = 0.00015;
const TAKER = 0.00045;

describe("inferFee", () => {
  it("recognises a maker fee in whole USD", () => {
    expect(inferFee(0.000645, false, 4.3, MAKER, TAKER)).toEqual({ feeUsd: 0.000645, isMaker: true });
  });
  it("recognises a taker fee, i.e. an order that crossed", () => {
    const r = inferFee(0.001935, false, 4.3, MAKER, TAKER)!;
    expect(r.isMaker).toBe(false);
    expect(r.feeUsd).toBeCloseTo(0.001935, 8);
  });
  it("handles USDC base units (1e6)", () => {
    const r = inferFee(645, false, 4.3, MAKER, TAKER)!;
    expect(r.isMaker).toBe(true);
    expect(r.feeUsd).toBeCloseTo(0.000645, 8);
    expect(inferFee(1935, false, 4.3, MAKER, TAKER)!.isMaker).toBe(false);
  });
  it("treats a rebate as a negative fee on a maker fill", () => {
    const r = inferFee(0.0004, true, 4.3, MAKER, TAKER)!;
    expect(r.isMaker).toBe(true);
    expect(r.feeUsd).toBeLessThan(0);
  });
  it("treats a zero fee as maker and refuses to guess without data", () => {
    expect(inferFee(0, false, 4.3, 0, TAKER)).toEqual({ feeUsd: 0, isMaker: true });
    expect(inferFee(undefined, false, 4.3, MAKER, TAKER)).toBeNull();
    expect(inferFee(1, false, 0, MAKER, TAKER)).toBeNull();
  });
});

describe("feeWindow", () => {
  it("sums the window and computes the maker fraction", () => {
    const w = feeWindow([
      { volume: "1000", maker_volume: "900", taker_volume: "100" },
      { volume: "500", maker_volume: "500", taker_volume: "0" },
    ]);
    expect(w).toEqual({ totalUsd: 1500, makerUsd: 1400, takerUsd: 100, makerFraction: 1400 / 1500 });
  });
  it("returns a null fraction with no volume", () => {
    expect(feeWindow([]).makerFraction).toBeNull();
  });
});
