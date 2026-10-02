import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deploy/decibel-dashboard.service", () => {
  const unit = readFileSync(new URL("../deploy/decibel-dashboard.service", import.meta.url), "utf8");
  const active = unit.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("never lets systemd kill the bot together with the dashboard", () => {
    expect(active).toContain("KillMode=process");
  });

  it("restarts itself and runs as the trading user with the control buttons", () => {
    expect(active).toContain("Restart=always");
    expect(active).toContain("User=mm");
    expect(active.some((l) => l.startsWith("ExecStart=") && l.includes("dashboard config.json") && l.includes("--control"))).toBe(true);
  });
});
