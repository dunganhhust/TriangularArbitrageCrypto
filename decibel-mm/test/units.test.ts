import { describe, expect, it } from "vitest";
import { detectUnits } from "../src/exchange/decibel.js";

describe("detectUnits", () => {
  it("recognises chain-scaled prices from the oracle ratio", () => {
    expect(detectUnits([60_000_000_000, 60_000_100_000], 100_000, 6, 60_000)).toBe("chain");
  });
  it("recognises fractional prices as human", () => {
    expect(detectUnits([60000.1, 60000.2], 100_000, 6, 60000)).toBe("human");
  });
  it("treats small integral values as human", () => {
    expect(detectUnits([3, 5, 8], 1, 4)).toBe("human");
  });
  it("refuses to guess when integral values are large and aligned", () => {
    expect(detectUnits([60000, 59990], 10, 1, 60000)).toBe("unknown");
  });
});
