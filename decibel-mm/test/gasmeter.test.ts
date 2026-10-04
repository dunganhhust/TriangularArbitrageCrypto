import { describe, expect, it } from "vitest";
import { GasMeter } from "../src/exchange/gasmeter.js";

describe("GasMeter", () => {
  it("adds up gas in APT, in total and per path, with the unit price of the latest transaction", () => {
    const g = new GasMeter();
    g.record({ encrypted: true, gasUsed: 270, gasUnitPrice: 200 }); // 54,000 octas
    g.record({ encrypted: true, gasUsed: 300, gasUnitPrice: 200 }); // 60,000
    g.record({ encrypted: false, gasUsed: 280, gasUnitPrice: 100 }); // 28,000
    expect(g.txCount).toBe(3);
    expect(g.gasApt).toBeCloseTo(142_000 / 1e8, 12);
    const p = g.byPath();
    expect(p.encrypted).toMatchObject({ tx: 2, unitPrice: 200 });
    expect(p.encrypted.avgApt).toBeCloseTo(57_000 / 1e8, 12);
    expect(p.plain).toMatchObject({ tx: 1, unitPrice: 100 });
    expect(p.plain.avgApt).toBeCloseTo(28_000 / 1e8, 12);
  });

  it("copes with missing numbers and an empty path", () => {
    const g = new GasMeter();
    g.record({ encrypted: false });
    expect(g.gasApt).toBe(0);
    expect(g.byPath().encrypted).toEqual({ tx: 0, gasApt: 0, unitPrice: null, avgApt: null });
    expect(g.byPath().plain.avgApt).toBe(0);
  });
});
