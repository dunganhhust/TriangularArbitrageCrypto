import { describe, expect, it } from "vitest";
import { PointsController } from "../src/strategy/points.js";
import type { PointsConfig } from "../src/strategy/points.js";
import type { Fill } from "../src/types.js";

const cfg: PointsConfig = {
  costBudgetBps: 0.5, minSpreadMult: 0.5, maxSpreadMult: 4, dailyVolumeTargetUsd: 100_000, streakMinVolumeUsd: 10_000,
  markoutMs: 1_000, ewmaHalfLifeUsd: 5_000, minSampleUsd: 1_000, step: 1.1, controlIntervalMs: 1_000,
};
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const fill = (id: number, side: "buy" | "sell", price: number, ts: number, size = 0.1): Fill =>
  ({ id: String(id), market: "M", side, price, size, feeUsd: 0, isMaker: true, ts });

/** Feed N fills each followed by a markout against `laterMid`. */
function feed(c: PointsController, n: number, px: number, laterMid: number, startTs: number): number {
  let ts = startTs;
  for (let i = 0; i < n; i++) {
    c.onFill(fill(i, "buy", px, ts, 0.1), px);
    ts += 1_500;
    c.tick(ts, () => laterMid);
  }
  return ts;
}

describe("PointsController", () => {
  it("widens when fills are adversely selected beyond the cost budget", () => {
    const c = new PointsController(cfg);
    // buy at 60000, mid later 59970 => -5 bps per fill
    const ts = feed(c, 60, 60000, 59970, T0);
    c.spreadMult(ts);
    const m = c.spreadMult(ts + 5_000);
    expect(c.stats(ts).ewmaPnlBps).toBeLessThan(-0.5);
    expect(m).toBeGreaterThan(1);
  });

  it("tightens when comfortably profitable (cost under budget)", () => {
    const c = new PointsController(cfg);
    const ts = feed(c, 60, 60000, 60030, T0); // +5 bps per fill
    const m = c.spreadMult(ts + 5_000);
    expect(m).toBeLessThan(1);
  });

  it("stays within bounds", () => {
    const c = new PointsController(cfg);
    let ts = feed(c, 200, 60000, 59000, T0);
    let m = 1;
    for (let i = 0; i < 200; i++) m = c.spreadMult((ts += 2_000));
    expect(m).toBeLessThanOrEqual(cfg.maxSpreadMult);
    const c2 = new PointsController(cfg);
    ts = feed(c2, 200, 60000, 61000, T0);
    for (let i = 0; i < 200; i++) m = c2.spreadMult((ts += 2_000));
    expect(m).toBeGreaterThanOrEqual(cfg.minSpreadMult);
  });

  it("pays up for volume when behind schedule and not losing", () => {
    const c = new PointsController(cfg);
    const late = Date.UTC(2026, 0, 1, 20, 0, 0); // 83% of the day, no volume yet
    expect(c.spreadMult(late)).toBeLessThan(1);
  });

  it("tracks daily volume, maker share and resets at UTC midnight", () => {
    const c = new PointsController(cfg);
    c.onFill(fill(1, "buy", 100, T0, 10), 100);
    c.onFill({ ...fill(2, "sell", 100, T0, 5), isMaker: false }, 100);
    const s = c.stats(T0);
    expect(s.dayVolumeUsd).toBe(1500);
    expect(s.dayMakerVolumeUsd).toBe(1000);
    expect(s.dayTakerVolumeUsd).toBe(500);
    expect(c.stats(T0 + 86_400_000).dayVolumeUsd).toBe(0);
  });

  it("restores same-day state", () => {
    const c = new PointsController(cfg);
    c.restore({ dayKey: "2026-01-01", dayVolumeUsd: 42_000, spreadMult: 1.7 });
    const s = c.stats(T0);
    expect(s.dayVolumeUsd).toBe(42_000);
    expect(s.spreadMult).toBeCloseTo(1.7);
  });
});
