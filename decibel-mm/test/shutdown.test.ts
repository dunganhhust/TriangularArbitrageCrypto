import { describe, expect, it } from "vitest";
import { analyze, parseLog } from "../src/dashboard/analyze.js";
import { Shutdown } from "../src/runner.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const events: string[] = [];
  const cancel = deferred();
  const sd = new Shutdown({
    haltAll: async () => {
      events.push("haltAll:start");
      await cancel.promise;
      events.push("haltAll:done");
    },
    close: async () => {
      events.push("close");
    },
    exit: (c) => events.push(`exit:${c}`),
    log: (_l, m) => events.push(`log:${m}`),
  });
  return { sd, events, cancel };
}

describe("Shutdown", () => {
  it("does not exit until the cancels have finished, and the main loop waits for it", async () => {
    const { sd, events, cancel } = setup();
    expect(sd.pending()).toBeNull();
    void sd.onSignal("SIGTERM");
    expect(sd.pending()).not.toBeNull(); // visible at once, before any await: this is what the loop checks
    await Promise.resolve();
    expect(events).toContain("haltAll:start");
    expect(events.some((e) => e.startsWith("exit"))).toBe(false); // cancels still in flight

    // The control loop notices the halt right away and must wait instead of exiting with code 2.
    const loop = (async () => {
      const p = sd.pending();
      if (p) await p;
    })();
    cancel.resolve();
    await loop;
    expect(events.filter((e) => e.startsWith("exit"))).toEqual(["exit:0"]);
    expect(events.indexOf("exit:0")).toBeGreaterThan(events.indexOf("haltAll:done"));
  });

  it("a second signal during shutdown does not cancel twice", async () => {
    const { sd, events, cancel } = setup();
    const a = sd.onSignal("SIGINT");
    const b = sd.onSignal("SIGINT");
    cancel.resolve();
    await Promise.all([a, b]);
    expect(events.filter((e) => e === "haltAll:start")).toHaveLength(1);
    expect(events.filter((e) => e.startsWith("exit"))).toEqual(["exit:0"]);
  });

  it("still exits (and closes) when cancelling throws", async () => {
    const events: string[] = [];
    const sd = new Shutdown({
      haltAll: async () => {
        throw new Error("rpc down");
      },
      close: async () => {
        events.push("close");
      },
      exit: (c) => events.push(`exit:${c}`),
      log: () => {},
    });
    await sd.onSignal("SIGTERM").catch(() => {});
    expect(events).toEqual(["close", "exit:0"]);
  });

  it("while positions are being closed the first signal is ignored and the second aborts", async () => {
    const { sd, events } = setup();
    sd.markEnding();
    await sd.onSignal("SIGTERM");
    expect(events).toEqual(["log:closing positions; send the signal again to abort"]);
    await sd.onSignal("SIGTERM");
    expect(events.at(-1)).toBe("exit:1");
    expect(events).not.toContain("haltAll:start");
  });
});

describe("how the dashboard labels a run stopped by a signal", () => {
  const line = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ t: new Date(Date.parse("2026-10-02T10:00:00Z") + ms).toISOString(), level, msg, ...extra });

  it("is 'stopped', not 'halted', even if an older bot also logged 'halted; exiting' on the way out", () => {
    const lines = parseLog(
      [line(0, "info", "market maker started", { markets: ["ETH/USD"] }), line(1000, "warn", "shutting down, cancelling quotes", { sig: "SIGTERM" }), line(1100, "error", "halted; exiting")].join("\n"),
    );
    const d = analyze(lines, { now: Date.parse("2026-10-02T10:05:00Z"), staleMs: 120_000, aptUsd: 1, killFile: false });
    expect(d.run.state).toBe("stopped");
  });

  it("still reports a real HALT as halted", () => {
    const lines = parseLog([line(0, "info", "market maker started", { markets: ["ETH/USD"] }), line(1000, "error", "HALT", { reason: "drawdown" }), line(1100, "error", "halted; exiting")].join("\n"));
    const d = analyze(lines, { now: Date.parse("2026-10-02T10:05:00Z"), staleMs: 120_000, aptUsd: 1, killFile: false });
    expect(d.run.state).toBe("halted");
  });
});
