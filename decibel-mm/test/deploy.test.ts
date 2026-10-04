import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deploy/decibel-dashboard.service", () => {
  const unit = readFileSync(new URL("../deploy/decibel-dashboard.service", import.meta.url), "utf8");
  const active = unit.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("never lets systemd kill the bot together with the dashboard", () => {
    expect(active).toContain("KillMode=process");
  });

  it("keeps being restarted however often it fails, and stops promptly", () => {
    expect(active).toContain("StartLimitIntervalSec=0");
    expect(active).toContain("Restart=always");
    expect(active.some((l) => l.startsWith("TimeoutStopSec="))).toBe(true);
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

describe("dashboard health check units", () => {
  const svc = readFileSync(new URL("../deploy/decibel-dashboard-health.service", import.meta.url), "utf8");
  const timer = readFileSync(new URL("../deploy/decibel-dashboard-health.timer", import.meta.url), "utf8");
  const active = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("probes the dashboard's health endpoint several times before restarting only the dashboard", () => {
    const exec = active(svc).find((l) => l.startsWith("ExecStart="))!;
    expect(exec).toContain("/healthz");
    expect(exec).toContain("for i in 1 2 3");
    expect(exec).toContain("systemctl restart decibel-dashboard");
    expect(exec).not.toMatch(/decibel-mm\b(?!-)/); // never touches the bot's own unit
    expect(active(svc)).toContain("Type=oneshot");
  });

  it("runs every minute and after boot", () => {
    expect(active(timer)).toContain("OnUnitActiveSec=1min");
    expect(active(timer).some((l) => l.startsWith("OnBootSec="))).toBe(true);
    expect(active(timer)).toContain("WantedBy=timers.target");
  });
});

describe("Windows tunnel launcher", () => {
  const ps = readFileSync(new URL("../deploy/windows/dashboard-tunnel.ps1", import.meta.url), "utf8");
  const bat = readFileSync(new URL("../deploy/windows/dashboard-tunnel.bat", import.meta.url), "utf8");

  it("forwards the local port to the dashboard port on the VM and reconnects by itself", () => {
    expect(ps).toContain("while ($true)");
    expect(ps).toContain("Start-Sleep -Seconds 3");
    expect(ps).toContain('"${LocalPort}:localhost:8787"');
    expect(ps).toContain("ServerAliveInterval=20");
    expect(ps).toContain("ServerAliveCountMax=3");
    expect(ps).toContain("ExitOnForwardFailure=yes");
    expect(ps).toContain('"-N"');
  });

  it("only ever listens on this PC's own loopback and never exposes the page elsewhere", () => {
    expect(ps).not.toContain("0.0.0.0");
    expect(ps).not.toMatch(/-L\s+\*:/);
    expect(ps).not.toContain("GatewayPorts");
  });

  it("the batch file just runs the script next to it", () => {
    expect(bat).toContain('-File "%~dp0dashboard-tunnel.ps1"');
  });
});
