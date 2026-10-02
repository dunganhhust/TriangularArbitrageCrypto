import { describe, expect, it } from "vitest";
import { VolatilityFuse } from "../src/strategy/fuse.js";
import type { FuseConfig, FuseInput } from "../src/strategy/fuse.js";

const cfg: FuseConfig = {
  enabled: true, fastMoveBps: 15, fastWindowMs: 5_000, slowMoveBps: 40, slowWindowMs: 60_000,
  spreadBps: 10, oracleDevBps: 15, cooldownMs: 60_000, maxCooldownMs: 1_800_000,
  recoverMs: 300_000, recoverWiden: 2, haltAfterTripsPerHour: 4, toxicFills: 5, toxicMarkoutBps: 3,
};
const T0 = 1_000_000;
const calm = (fair: number): FuseInput => ({ fair, spreadBps: 0.1, oracleDevBps: 1 });

describe("VolatilityFuse", () => {
  it("stays ok in a calm market", () => {
    const f = new VolatilityFuse(cfg);
    for (let i = 0; i < 100; i++) expect(f.observe(T0 + i * 250, calm(86000 + (i % 3))).state).toBe("ok");
  });

  it("trips on a fast move and reports the trip once", () => {
    const f = new VolatilityFuse(cfg);
    f.observe(T0, calm(86000));
    f.observe(T0 + 1000, calm(86000));
    const s = f.observe(T0 + 2000, calm(86000 * 1.002)); // +20 bps in 2s
    expect(s).toMatchObject({ state: "tripped", justTripped: true });
    expect(f.observe(T0 + 3000, calm(86200))).toMatchObject({ state: "tripped", justTripped: false });
  });

  it("trips on a slow grind, a blown-out spread and an oracle divergence", () => {
    const slow = new VolatilityFuse(cfg);
    let state = "ok";
    for (let i = 0; i <= 60 && state === "ok"; i++) state = slow.observe(T0 + i * 1000, calm(86000 * (1 + (i * 1.2) / 1e4))).state; // 1.2 bps/s
    expect(state).toBe("tripped");
    expect(new VolatilityFuse(cfg).observe(T0, { fair: 86000, spreadBps: 12, oracleDevBps: 0 }).state).toBe("tripped");
    expect(new VolatilityFuse(cfg).observe(T0, { fair: 86000, spreadBps: 0.1, oracleDevBps: 20 }).state).toBe("tripped");
  });

  it("pauses, then recovers with quotes widened and narrowing back to normal", () => {
    const f = new VolatilityFuse(cfg);
    f.observe(T0, calm(86000));
    f.trip(T0, "test");
    expect(f.observe(T0 + 59_000, calm(86000)).state).toBe("tripped");
    const early = f.observe(T0 + 61_000, calm(86000));
    expect(early.state).toBe("recovering");
    const mid = f.observe(T0 + 60_000 + 150_000, calm(86000));
    const late = f.observe(T0 + 60_000 + 290_000, calm(86000));
    if (early.state !== "recovering" || mid.state !== "recovering" || late.state !== "recovering") throw new Error("expected recovering");
    expect(early.widen).toBeGreaterThan(1.9);
    expect(mid.widen).toBeGreaterThan(1.4);
    expect(mid.widen).toBeLessThan(1.6);
    expect(late.widen).toBeLessThan(1.1);
    expect(f.observe(T0 + 60_000 + 301_000, calm(86000)).state).toBe("ok");
  });

  it("doubles the pause on repeated trips and halts after too many in an hour", () => {
    const f = new VolatilityFuse(cfg);
    const a = f.trip(T0, "a");
    const b = f.trip(T0 + 10_000, "b");
    if (a.state !== "tripped" || b.state !== "tripped") throw new Error("expected tripped");
    expect(a.until - T0).toBe(60_000);
    expect(b.until - (T0 + 10_000)).toBe(120_000);
    f.trip(T0 + 20_000, "c");
    expect(f.trip(T0 + 30_000, "d").state).toBe("halt");
    expect(f.observe(T0 + 90_000_000, calm(86000)).state).toBe("halt"); // stays halted
  });

  it("forgets trips older than an hour", () => {
    const f = new VolatilityFuse(cfg);
    f.trip(T0, "a");
    f.trip(T0 + 1_000, "b");
    f.observe(T0 + 3_700_000, calm(86000));
    expect(f.tripsInLastHour).toBe(0);
  });

  it("does nothing when disabled", () => {
    const f = new VolatilityFuse({ ...cfg, enabled: false });
    expect(f.trip(T0, "x").state).toBe("ok");
    expect(f.observe(T0, { fair: 1, spreadBps: 999, oracleDevBps: 999 }).state).toBe("ok");
  });
});
