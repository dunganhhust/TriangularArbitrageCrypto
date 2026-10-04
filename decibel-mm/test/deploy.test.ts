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

describe("bot service unit", () => {
  const unit = readFileSync(new URL("../deploy/decibel-mm.service", import.meta.url), "utf8");
  const active = unit.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("runs the supervisor, not the bare bot, and loads the keys the way the dashboard does", () => {
    expect(active).toMatch(/ExecStart=.*set -a; \. \/etc\/decibel-mm\/env; set \+a; exec node --import tsx src\/cli\.ts supervise config\.json/);
  });

  it("never restarts after a halt, an unclosed position or a supervisor give-up", () => {
    expect(active).toMatch(/Restart=on-failure/);
    expect(active).toMatch(/RestartPreventExitStatus=2 3\b/);
  });

  it("gives the bot time to cancel its quotes on stop and does not detach it from the unit", () => {
    expect(active).toMatch(/TimeoutStopSec=(\d+)/);
    expect(Number(/TimeoutStopSec=(\d+)/.exec(active)![1])).toBeGreaterThanOrEqual(60);
    expect(active).not.toMatch(/KillMode=process/); // here the bot SHOULD stop with the unit
    expect(active).toMatch(/KillMode=mixed/); // one SIGTERM, to the supervisor, which forwards exactly one to the bot
  });
});
