import { describe, expect, it } from "vitest";
import { RampController } from "../src/strategy/ramp.js";
import type { RampConfig } from "../src/strategy/ramp.js";

const cfg: RampConfig = { enabled: true, stages: [0.25, 0.5, 1], minStageMs: 3_600_000, minStageFills: 10, maxStageLossPct: 3, maxStageTrips: 0 };
const H = 3_600_000;

describe("RampController", () => {
  it("starts at the first stage and ignores updates until it has a baseline", () => {
    const r = new RampController(cfg);
    expect(r.mult).toBe(0.25);
    expect(r.update(0, null, { fills: 0, trips: 0 }).kind).toBe("none");
    expect(r.update(0, 100, { fills: 0, trips: 0 }).kind).toBe("none");
    expect(r.mult).toBe(0.25);
  });

  it("advances only with enough time AND fills AND calm", () => {
    const r = new RampController(cfg);
    r.update(0, 100, { fills: 0, trips: 0 });
    expect(r.update(H, 100, { fills: 5, trips: 0 }).kind).toBe("none"); // too few fills
    expect(r.update(H / 2, 100, { fills: 50, trips: 0 }).kind).toBe("none"); // too early
    expect(r.update(H, 100, { fills: 50, trips: 1 }).kind).toBe("none"); // fuse tripped
    expect(r.update(H, 100, { fills: 50, trips: 0 })).toMatchObject({ kind: "advanced", from: 0, to: 1 });
    expect(r.mult).toBe(0.5);
  });

  it("does not advance while equity is bleeding even if under the limit", () => {
    const r = new RampController(cfg);
    r.update(0, 100, { fills: 0, trips: 0 });
    expect(r.update(2 * H, 98, { fills: 50, trips: 0 }).kind).toBe("none"); // -2% >= half the 3% limit
  });

  it("demotes on a loss and halts when already at the first stage", () => {
    const r = new RampController(cfg);
    r.update(0, 100, { fills: 0, trips: 0 });
    r.update(H, 100, { fills: 50, trips: 0 });
    r.update(2 * H, 100, { fills: 120, trips: 0 });
    expect(r.mult).toBe(1);
    expect(r.update(3 * H, 96, { fills: 130, trips: 0 })).toMatchObject({ kind: "demoted", from: 2, to: 1 });
    expect(r.mult).toBe(0.5);
    r.update(4 * H, 96, { fills: 130, trips: 0 });
    r.update(5 * H, 90, { fills: 140, trips: 0 });
    expect(r.mult).toBe(0.25);
    expect(r.update(6 * H, 80, { fills: 150, trips: 0 }).kind).toBe("exhausted");
  });

  it("restores a stage but restarts the evidence window", () => {
    const r = new RampController(cfg);
    r.restoreStage(1);
    expect(r.mult).toBe(0.5);
    expect(r.update(10 * H, 100, { fills: 500, trips: 0 }).kind).toBe("none"); // baseline only
    expect(r.update(11 * H, 100, { fills: 600, trips: 0 })).toMatchObject({ kind: "advanced", to: 2 });
  });

  it("is a no-op when disabled", () => {
    const r = new RampController({ ...cfg, enabled: false });
    expect(r.mult).toBe(1);
    expect(r.update(0, 100, { fills: 0, trips: 0 }).kind).toBe("none");
  });
});
