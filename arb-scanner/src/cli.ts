import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { crossOpp, fundingEdge, OppTracker } from "./scanner.js";
import type { Log, Venue } from "./types.js";
import { Decibel } from "./venues/decibel.js";
import { Hyperliquid } from "./venues/hyperliquid.js";
import { Lighter } from "./venues/lighter.js";

const log: Log = (msg, extra) => console.error(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

function append(file: string, row: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + "\n");
}

function buildVenues(cfg: Config, only?: string): Venue[] {
  const v = cfg.venues;
  const out: Venue[] = [];
  const want = (n: string, enabled: boolean): boolean => (only ? only === n : enabled);
  if (want("hyperliquid", v.hyperliquid.enabled)) out.push(new Hyperliquid(log, v.hyperliquid.fees, v.hyperliquid.url, v.hyperliquid.symbolMap));
  if (want("lighter", v.lighter.enabled)) out.push(new Lighter(log, v.lighter.fees, v.lighter.url, v.lighter.symbolMap));
  if (want("decibel", v.decibel.enabled)) {
    const key = process.env.APTOS_NODE_API_KEY;
    if (key) out.push(new Decibel(log, key, v.decibel.fees));
    else log("decibel skipped: APTOS_NODE_API_KEY is not set");
  }
  return out;
}

async function startAll(venues: Venue[], symbols: string[]): Promise<Venue[]> {
  const ok: Venue[] = [];
  for (const v of venues) {
    try {
      await v.start(symbols);
      log("venue started", { venue: v.name, symbols: v.symbols() });
      if (v.symbols().length) ok.push(v);
    } catch (e) {
      log("venue failed to start", { venue: v.name, error: String(e) });
    }
  }
  return ok;
}

async function scan(cfg: Config, only?: string): Promise<void> {
  const venues = await startAll(buildVenues(cfg, only), cfg.symbols);
  if (venues.length < 2) throw new Error(`need at least two working venues, have ${venues.length}`);
  const tracker = new OppTracker(cfg.minNetBps, cfg.graceMs, (c) => append(cfg.logFile, { ts: new Date(c.startedAt).toISOString(), ...c }));
  const best = new Map<string, { net: number; gross: number }>();
  const counts = new Map<string, number>();
  let scans = 0;

  const tick = (): void => {
    const now = Date.now();
    scans++;
    for (const sym of cfg.symbols) {
      for (const a of venues) {
        for (const b of venues) {
          if (a === b) continue;
          const ba = a.book(sym);
          const bb = b.book(sym);
          const fresh = ba && bb && now - ba.ts <= cfg.maxBookAgeMs && now - bb.ts <= cfg.maxBookAgeMs;
          for (const n of cfg.notionalUsd) {
            const key = `${sym} buy@${a.name} sell@${b.name} $${n}`;
            const o = fresh ? crossOpp(ba, bb, a.fees, b.fees, n, cfg.extraBps) : null;
            tracker.update(key, o ? o.netBps : null, now);
            if (!o) continue;
            const cur = best.get(key);
            if (!cur || o.netBps > cur.net) best.set(key, { net: o.netBps, gross: o.grossBps });
            if (o.netBps > cfg.minNetBps) counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
    }
  };

  const status = (): void => {
    const rows = [...best].sort((x, y) => y[1].net - x[1].net).slice(0, 8);
    console.log(`\n[${new Date().toISOString().slice(11, 19)}] scans=${scans} open=${tracker.openCount} (best net bps per route since last status)`);
    for (const [k, v] of rows) console.log(`  ${k.padEnd(48)} net ${v.net.toFixed(2).padStart(7)}  gross ${v.gross.toFixed(2).padStart(7)}  hits ${counts.get(k) ?? 0}`);
    best.clear();
    counts.clear();
  };

  const fundingReport = (): void => {
    for (const sym of cfg.symbols) {
      const have = venues.filter((v) => v.funding(sym));
      for (let i = 0; i < have.length; i++)
        for (let j = i + 1; j < have.length; j++) {
          const a = have[i]!;
          const b = have[j]!;
          const e = fundingEdge(a.name, a.funding(sym)!, a.fees, b.name, b.funding(sym)!, b.fees, cfg.holdDays);
          append(cfg.fundingFile, { ts: new Date().toISOString(), symbol: sym, ...e });
        }
    }
  };

  const timers = [setInterval(tick, cfg.scanIntervalMs), setInterval(status, cfg.statusEveryMs), setInterval(fundingReport, cfg.fundingEveryMs)];
  const stop = (): void => {
    timers.forEach(clearInterval);
    tracker.flush();
    venues.forEach((v) => v.stop());
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log("scanning", { venues: venues.map((v) => v.name), symbols: cfg.symbols, notionalUsd: cfg.notionalUsd, extraBps: cfg.extraBps, opps: cfg.logFile });
}

async function funding(cfg: Config, only?: string): Promise<void> {
  const venues = await startAll(buildVenues(cfg, only), cfg.symbols);
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`funding per day, bps of notional (hold ${cfg.holdDays}d; net = carry - 2x taker fees both legs)`);
  for (const sym of cfg.symbols) {
    for (const v of venues) {
      const f = v.funding(sym);
      console.log(`  ${sym.padEnd(6)} ${v.name.padEnd(12)} ${f ? (f.ratePerHour * 24 * 1e4).toFixed(2).padStart(8) + " bps/day" : "       -"}`);
    }
    const have = venues.filter((v) => v.funding(sym));
    for (let i = 0; i < have.length; i++)
      for (let j = i + 1; j < have.length; j++) {
        const a = have[i]!;
        const b = have[j]!;
        const e = fundingEdge(a.name, a.funding(sym)!, a.fees, b.name, b.funding(sym)!, b.fees, cfg.holdDays);
        console.log(`    long ${e.longOn} / short ${e.shortOn}: ${e.bpsPerDay.toFixed(2)} bps/day (${e.aprPct.toFixed(1)}% APR), net over hold ${e.netBpsOverHold.toFixed(1)} bps, break-even ${e.breakEvenDays.toFixed(1)}d`);
      }
  }
  venues.forEach((v) => v.stop());
  process.exit(0);
}

async function probe(cfg: Config, only: string | undefined, symbol: string): Promise<void> {
  if (!only) throw new Error("usage: probe <venue> [symbol]");
  const venues = await startAll(buildVenues(cfg, only), [symbol]);
  await new Promise((r) => setTimeout(r, 6000));
  for (const v of venues) {
    console.log(`--- ${v.name}: raw samples`);
    (v.samples ?? []).forEach((s) => console.log(s));
    const b = v.book(symbol);
    console.log(`--- parsed book (${symbol}):`, b ? JSON.stringify({ bids: b.bids.slice(0, 3), asks: b.asks.slice(0, 3) }) : "none");
    console.log("--- funding:", JSON.stringify(v.funding(symbol)));
  }
  venues.forEach((v) => v.stop());
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const cfg = loadConfig(flag("config"));
const run = cmd === "scan" ? scan(cfg, flag("venue")) : cmd === "funding" ? funding(cfg, flag("venue")) : cmd === "probe" ? probe(cfg, rest[0], rest[1] ?? "ETH") : Promise.reject(new Error("usage: scan|funding [--config file] [--venue name] | probe <venue> [symbol]"));
run.catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
