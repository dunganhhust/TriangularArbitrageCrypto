import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";

const load = (f: string) => configSchema.parse(JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")));

describe("shipped configs", () => {
  it("config.example.json parses", () => {
    expect(() => load("config.example.json")).not.toThrow();
  });

  it("config.24x7.example.json parses and carries every unattended-run safeguard", () => {
    const c = load("config.24x7.example.json");
    expect(c.network).toBe("mainnet");
    expect(c.sizing.leverage).toBeGreaterThan(0); // volume follows equity
    expect(c.risk.maxDailyLossUsd).toBeGreaterThan(0);
    expect(c.risk.minEquityUsd).toBeGreaterThan(0);
    expect(c.risk.maxDrawdownUsd).toBeGreaterThan(0);
    expect(c.engine.watchdogMs).toBeGreaterThan(0);
    expect(c.fuse.haltMode).toBe("cooloff"); // a volatile hour must not end an unattended run for good
    expect(c.ramp.enabled).toBe(false); // sizing already follows equity
    expect(c.gas.priceFeed).toBe(true);
    // the daily loss limit is tighter than the total drawdown, which is tighter than the equity floor allows
    expect(c.risk.maxDailyLossUsd).toBeLessThan(c.risk.maxDrawdownUsd);
  });

  it("defaults keep the old behaviour for configs that do not mention the new sections", () => {
    const c = configSchema.parse({ markets: [{ name: "ETH/USD", maxPositionUsd: 15, levelSizeUsd: 5 }] });
    expect(c.sizing.leverage).toBe(0);
    expect(c.risk.maxDailyLossUsd).toBe(0);
    expect(c.risk.minEquityUsd).toBe(0);
    expect(c.fuse.haltMode).toBe("halt");
    expect(c.competition.touchGuardTicks).toBe(0);
  });
});
