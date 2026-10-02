import { describe, expect, it } from "vitest";
import { assess } from "../src/strategy/risk.js";
import type { RiskConfig, RiskInput } from "../src/strategy/risk.js";

const cfg: RiskConfig = {
  staleBookMs: 3000, maxOracleDevBps: 40, maxSpreadBps: 25, emergencyPositionUsd: 750, reduceToUsd: 250,
  maxDrawdownUsd: 50, maxConsecutiveFailures: 4, cooldownMs: 15000,
};
const ok: RiskInput = {
  now: 10_000,
  book: { bids: [{ price: 100, size: 1 }], asks: [{ price: 100.02, size: 1 }], ts: 9_500 },
  price: { mark: 100, mid: 100, oracle: 100, fundingBps: 0, ts: 9_500 },
  positionUsd: 0, equityUsd: 1000, startEquityUsd: 1000, consecutiveFailures: 0, cooldownUntil: 0, killSwitch: false,
};

describe("assess", () => {
  it("quotes in normal conditions", () => expect(assess(cfg, ok).kind).toBe("quote"));
  it("halts on kill switch and on drawdown", () => {
    expect(assess(cfg, { ...ok, killSwitch: true }).kind).toBe("halt");
    expect(assess(cfg, { ...ok, equityUsd: 940 }).kind).toBe("halt");
    expect(assess(cfg, { ...ok, equityUsd: 960 }).kind).toBe("quote");
  });
  it("pauses on stale, crossed, empty, wide or oracle-divergent books", () => {
    expect(assess(cfg, { ...ok, now: 20_000 })).toMatchObject({ kind: "pause", reason: "stale book" });
    expect(assess(cfg, { ...ok, book: { ...ok.book!, bids: [{ price: 101, size: 1 }] } })).toMatchObject({ reason: "crossed book" });
    expect(assess(cfg, { ...ok, book: null }).kind).toBe("pause");
    expect(assess(cfg, { ...ok, book: { ...ok.book!, asks: [{ price: 101, size: 1 }] } })).toMatchObject({ reason: "spread too wide" });
    expect(assess(cfg, { ...ok, price: { ...ok.price!, oracle: 101 } })).toMatchObject({ reason: "mid/oracle divergence" });
  });
  it("requests a reduce on the right side when position is beyond the emergency limit", () => {
    expect(assess(cfg, { ...ok, positionUsd: 900 })).toMatchObject({ kind: "reduce", side: "sell", sizeUsd: 650 });
    expect(assess(cfg, { ...ok, positionUsd: -900 })).toMatchObject({ kind: "reduce", side: "buy" });
  });
  it("respects the transaction cool-down", () => {
    expect(assess(cfg, { ...ok, cooldownUntil: 20_000 })).toMatchObject({ kind: "pause" });
  });
});
