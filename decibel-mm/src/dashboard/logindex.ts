import type { LogLine } from "./analyze.js";

/**
 * An incrementally built index over the bot's JSON-lines log.
 *
 * The dashboard asks for a fresh analysis every second. Re-scanning the whole log each time costs more the longer the bot
 * has been running (25 days of a 24/7 run took half a second per request and several hundred MB), so every line is looked
 * at once, when it arrives, and filed under the few categories the page needs. A request then slices those lists by time
 * (binary search) and only touches the window it is asked for.
 *
 * Lines the page never shows (units, fees, points, ...) are not kept at all, and the order-book detail (`quotes`) of old
 * ladders is dropped: only the latest ladder per market is ever displayed.
 */

const START = "market maker started";
const STOP_MSG = "shutting down, cancelling quotes";
/** Ladders newer than this many keep their `quotes`; older ones are shrunk to save memory. */
const KEEP_QUOTES = 30;

type Cat = "statuses" | "fills" | "placed" | "failed" | "notable" | "warns" | "errors" | "trips" | "pauses";
const CATS: Cat[] = ["statuses", "fills", "placed", "failed", "notable", "warns", "errors", "trips", "pauses"];

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

const hasQuotes = (l: LogLine): boolean => {
  const q = l.quotes;
  return !!q && typeof q === "object" && Array.isArray((q as { bids?: unknown }).bids) && Array.isArray((q as { asks?: unknown }).asks);
};

/** First index whose ts is >= `from` in an array sorted by ts. */
function lowerBound(a: LogLine[], from: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]!.ts < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One run of the bot: everything from a "market maker started" line to the next one. */
export class RunIndex {
  /** The start marker; null for a log with no marker at all (an old bot). */
  start: LogLine | null = null;
  firstLine: LogLine | null = null;
  lastLine: LogLine | null = null;
  /** The first status line ever seen in the run, kept even when older ones are trimmed. */
  firstStatus: LogLine | null = null;
  lastStatus: LogLine | null = null;
  /** Equity at the first status line (its own start equity when it has one). */
  firstEq: number | null = null;

  statuses: LogLine[] = [];
  fills: LogLine[] = [];
  placed: LogLine[] = [];
  failed: LogLine[] = [];
  /** Everything the Events table can show: not-info lines, ramp and rebate notices, the start marker. */
  notable: LogLine[] = [];
  warns: LogLine[] = [];
  errors: LogLine[] = [];
  trips: LogLine[] = [];
  pauses: LogLine[] = [];

  halt: LogLine | null = null;
  ending: LogLine | null = null;
  finished: LogLine | null = null;
  lastTrip: LogLine | null = null;
  stopped = false;
  haltedExit = false;
  /** Whole-run totals; they survive trimming of the lists above. */
  fillCount = 0;
  fillVolume = 0;
  lineCount = 0;
  /** Most recent ladder per market that still has its quotes. */
  lastQuoted = new Map<string, LogLine>();

  private quoted: LogLine[] = [];
  private lastTs: Partial<Record<Cat, number>> = {};
  private unsorted = new Set<Cat>();

  constructor(first: LogLine | null) {
    if (first) this.add(first);
  }

  get startedAt(): number | null {
    return this.start?.ts ?? this.firstLine?.ts ?? null;
  }

  /** Lines kept in the lists (a line in two lists counts twice; this is a memory budget, not a statistic). */
  get retained(): number {
    return this.statuses.length + this.fills.length + this.placed.length + this.notable.length + this.failed.length + this.trips.length + this.pauses.length;
  }

  private push(cat: Cat, l: LogLine): void {
    const prev = this.lastTs[cat];
    if (prev !== undefined && l.ts < prev) this.unsorted.add(cat);
    this.lastTs[cat] = l.ts;
    this[cat].push(l);
  }

  add(l: LogLine): void {
    this.lineCount++;
    this.firstLine ??= l;
    this.lastLine = l;
    const m = l.msg;
    if (m === START) this.start ??= l;
    if (m === "status") {
      this.push("statuses", l);
      this.firstStatus ??= l;
      this.lastStatus = l;
      if (this.firstEq === null) this.firstEq = num(l.startEquity) ?? num(l.equity);
    } else if (m === "fill") {
      this.push("fills", l);
      this.fillCount++;
      this.fillVolume += (num(l.px) ?? 0) * (num(l.sz) ?? 0);
    } else if (m === "ladder placed" || m === "DRY-RUN place_bulk_orders") {
      this.push("placed", l);
      if (hasQuotes(l)) this.keepQuotes(l);
    } else if (m === "bulk order tx failed" || m === "bulk order tx error" || m === "replace failed") {
      this.push("failed", l);
    } else if (m === "run finished") this.finished = l;
    else if (m === STOP_MSG) this.stopped = true;
    else if (m === "halted; exiting") this.haltedExit = true;
    else if (m.startsWith("run ending")) this.ending ??= l;
    else if (m === "pause") this.push("pauses", l);
    else if (m.startsWith("FUSE tripped")) {
      this.push("trips", l);
      this.lastTrip = l;
    }
    if (l.level === "warn") this.push("warns", l);
    else if (l.level === "error") {
      this.push("errors", l);
      if (m === "HALT") this.halt = l;
    }
    if (l.level !== "info" || m.startsWith("ramp:") || m.startsWith("maker rebate") || m === START) this.push("notable", l);
  }

  private keepQuotes(l: LogLine): void {
    this.lastQuoted.set(String(l.market ?? ""), l);
    this.quoted.push(l);
    if (this.quoted.length > KEEP_QUOTES) {
      const old = this.quoted.shift()!;
      if (this.lastQuoted.get(String(old.market ?? "")) !== old) delete old.quotes;
    }
  }

  /** The part of list `cat` at or after `from`. Falls back to a scan when the list is not in time order. */
  window(cat: Cat, from: number): LogLine[] {
    const a = this[cat];
    if (this.unsorted.has(cat)) return a.filter((l) => l.ts >= from);
    const i = lowerBound(a, from);
    return i === 0 ? a : a.slice(i);
  }

  /** The last line of `cat` with ts before `from` (or at/before it with `inclusive`). */
  lastBefore(cat: Cat, from: number, inclusive = false): LogLine | null {
    const a = this[cat];
    if (this.unsorted.has(cat)) {
      for (let i = a.length - 1; i >= 0; i--) if (inclusive ? a[i]!.ts <= from : a[i]!.ts < from) return a[i]!;
      return null;
    }
    // first index with ts >= from (or > from when inclusive)
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (inclusive ? a[mid]!.ts <= from : a[mid]!.ts < from) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? a[lo - 1]! : null;
  }

  /** Drop everything older than `cutoff` from the lists (the whole-run totals are kept). */
  dropBefore(cutoff: number): void {
    for (const cat of CATS) {
      const a = this[cat];
      if (this.unsorted.has(cat)) {
        this[cat] = a.filter((l) => l.ts >= cutoff || l === this.start);
        continue;
      }
      const i = lowerBound(a, cutoff);
      if (i > 0) this[cat] = a.slice(i);
    }
    // the start marker stays visible in Events
    if (this.start && !this.notable.includes(this.start)) this.notable.unshift(this.start);
  }
}

export class LogIndex {
  runs: RunIndex[] = [];
  /** Lines in a log that has no start marker (an old bot); only used while there is no real run. */
  private headless: RunIndex | null = null;
  /** Lines seen, including those the index does not keep. */
  total = 0;

  static from(lines: LogLine[]): LogIndex {
    const idx = new LogIndex();
    idx.add(lines);
    return idx;
  }

  add(lines: LogLine[]): void {
    for (const l of lines) {
      this.total++;
      if (l.msg === START) {
        this.runs.push(new RunIndex(l));
        this.headless = null;
      } else if (this.runs.length) this.runs[this.runs.length - 1]!.add(l);
      else (this.headless ??= new RunIndex(null)).add(l);
    }
  }

  /** The runs as the analysis sees them, oldest first. */
  get all(): RunIndex[] {
    return this.runs.length ? this.runs : this.headless ? [this.headless] : [];
  }

  get retained(): number {
    return this.all.reduce((a, r) => a + r.retained, 0);
  }

  /**
   * Keep memory bounded: once more than 1.25 x `max` lines are held, drop the oldest runs, and if a single run is still too
   * big, its oldest part, until about 0.8 x `max` remain.
   */
  trim(max: number): void {
    let total = this.retained;
    if (total <= max * 1.25) return;
    const target = max * 0.8;
    while (this.runs.length > 1 && total > target) total -= this.runs.shift()!.retained;
    const r = this.all[0];
    if (!r || total <= target || !r.firstLine || !r.lastLine) return;
    const keep = target / total;
    const span = r.lastLine.ts - r.firstLine.ts;
    if (span > 0) r.dropBefore(r.lastLine.ts - span * keep);
  }
}
