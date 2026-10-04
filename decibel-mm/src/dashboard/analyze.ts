/**
 * Turns the bot's JSON-lines run log (and the 1 s live snapshot) into the numbers the dashboard
 * shows. Pure: no I/O, the clock is passed in, so it is covered by unit tests.
 */

import { LogIndex, RunIndex } from "./logindex.js";

export { LogIndex };

export interface LogLine {
  t: string;
  ts: number;
  level: string;
  msg: string;
  [k: string]: unknown;
}

export type RunState = "no-data" | "running" | "finishing" | "stale" | "stopped" | "halted";

export interface Alert {
  level: "error" | "warn" | "info";
  text: string;
}

export interface AnalyzeOpts {
  now: number;
  /** Without a live snapshot, a run with no log line for this long is reported as stale. */
  staleMs: number;
  /** With a live snapshot (written every second) the threshold is this much tighter. */
  liveStaleMs?: number;
  /** USD price of 1 APT, used only to turn gas into dollars. */
  aptUsd: number;
  /** Whether the KILL file exists right now. */
  killFile: boolean;
  maxSeriesPoints?: number;
  maxRows?: number;
  /** Window length in ms for tables, charts and totals; null/undefined = the whole run. */
  rangeMs?: number | null;
  /** Restrict tables, charts and per-market totals to one market. */
  market?: string | null;
  /** Parsed contents of live.json, if present. */
  live?: Record<string, unknown> | null;
  /** Look at an earlier run: its start time (a RunSummary id). Default: the latest run. */
  runStart?: number | null;
}


export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.t !== "string" || typeof o.msg !== "string") continue;
      const ts = Date.parse(o.t);
      if (Number.isNaN(ts)) continue;
      out.push({ ...o, t: o.t, msg: o.msg, level: String(o.level ?? "info"), ts });
    } catch {
      // A partial line (tail cut, or the bot is mid-write) is simply skipped.
    }
  }
  return out;
}

/** Every run in the log, oldest first. A run starts at a "market maker started" marker. */
export function splitRuns(lines: LogLine[]): LogLine[][] {
  const runs: LogLine[][] = [];
  const headless: LogLine[] = [];
  let cur: LogLine[] | null = null;
  for (const l of lines) {
    if (l.msg === "market maker started") {
      cur = [l];
      runs.push(cur);
    } else if (cur) cur.push(l);
    else headless.push(l);
  }
  // A log with no start marker at all (written by a very old bot) is treated as one run; a partial run cut off by the
  // read window, followed by real runs, is dropped.
  if (!runs.length && headless.length) runs.push(headless);
  return runs;
}

/** Lines of the most recent run: everything from the last "market maker started" marker. */
export function lastRun(lines: LogLine[]): LogLine[] {
  const r = splitRuns(lines);
  return r.length ? r[r.length - 1]! : [];
}

const numOnly = (x: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec(x))) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
};

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

function numRecord(x: unknown): Record<string, number | null> {
  const o: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(rec(x))) o[k] = num(v);
  return o;
}

function thin<T>(a: T[], max: number): T[] {
  if (a.length <= max) return a;
  const step = a.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(a[Math.floor(i * step)]!);
  out.push(a[a.length - 1]!);
  return out;
}

function detailOf(l: LogLine): string {
  const { t: _t, ts: _ts, level: _level, msg: _msg, ...rest } = l;
  const s = Object.keys(rest).length ? JSON.stringify(rest) : "";
  return s.length > 260 ? s.slice(0, 257) + "..." : s;
}

export interface MarketView {
  name: string;
  mid: number | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  position: number | null;
  positionUsd: number | null;
  /** Position cap in force (configured cap scaled by the ramp stage). */
  capUsd: number | null;
  quoting: boolean | null;
  paused: string | null;
  fuse: string | null;
  fuseUntil: number | null;
  fuseReason: string | null;
  quotes: { bids: number[][]; asks: number[][] } | null;
  quotesAt: number | null;
  /** Totals within the selected window. */
  fills: number;
  maker: number;
  taker: number;
  volumeUsd: number;
  makerVolumeUsd: number;
  feesUsd: number;
}

export interface FillRow {
  t: number;
  market: string;
  side: string;
  px: number;
  sz: number;
  usd: number;
  maker: boolean;
  fee: number;
}

export type RunOutcome = "running" | "closed" | "residual" | "halted" | "signal" | "restarted" | "unknown";

/** One line of the run history: enough to recognise a run and see how it ended. */
export interface RunSummary {
  /** Start time (ms): the value to pass back as `run` to look at it. */
  id: number;
  startedAt: number;
  endedAt: number;
  dryRun: boolean;
  markets: string[];
  plannedMinutes: number | null;
  /** 1 for the first process of a supervised (24/7) session, 2 for the one started after a crash, ... null when not supervised. */
  attempt: number | null;
  fills: number;
  volumeUsd: number;
  equityStart: number | null;
  equityEnd: number | null;
  equityDelta: number | null;
  gasApt: number | null;
  txCount: number | null;
  outcome: RunOutcome;
  reason: string | null;
  residual: Record<string, number>;
}

function attemptOf(run: RunIndex): number | null {
  return num(run.start?.supervisedAttempt);
}

/** Summary of one run given as plain lines (the run's own lines, start marker first). */
export function summarizeRun(run: LogLine[], isLatest: boolean, now: number, staleMs: number, restartedAfter = false): RunSummary {
  const r = new RunIndex(null);
  for (const l of run) r.add(l);
  return summarizeIdx(r, isLatest, now, staleMs, restartedAfter);
}

export function summarizeIdx(run: RunIndex, isLatest: boolean, now: number, staleMs: number, restartedAfter = false): RunSummary {
  const start = run.start;
  const last = run.lastLine!;
  const startedAt = run.startedAt!;
  const fills = run.fillCount;
  const volumeUsd = run.fillVolume;
  const firstEq = run.firstEq;
  const lastStatus = run.lastStatus;
  const halt = run.halt;
  const signal = run.stopped;
  const finished = run.finished;
  const equityEnd = num(lastStatus?.equity);
  const endsAtIso = typeof start?.endsAt === "string" ? Date.parse(start.endsAt) : NaN;
  let outcome: RunOutcome;
  let reason: string | null = null;
  let residual: Record<string, number> = {};
  if (finished) {
    outcome = finished.flat === true ? "closed" : "residual";
    reason = String(finished.reason ?? "");
    residual = numOnly(finished.residual);
  } else if (halt) {
    outcome = "halted";
    reason = String(halt.reason ?? "");
  } else if (signal) outcome = "signal";
  else if (restartedAfter) outcome = "restarted";
  else if (isLatest && now - last.ts <= staleMs) outcome = "running";
  else outcome = "unknown";
  return {
    id: startedAt,
    startedAt,
    endedAt: last.ts,
    dryRun: start?.dryRun === true,
    markets: Array.isArray(start?.markets) ? (start!.markets as unknown[]).map(String) : [],
    plannedMinutes: Number.isFinite(endsAtIso) ? Math.round((endsAtIso - startedAt) / 60_000) : null,
    attempt: attemptOf(run),
    fills,
    volumeUsd,
    equityStart: firstEq,
    equityEnd,
    equityDelta: firstEq !== null && equityEnd !== null ? equityEnd - firstEq : null,
    gasApt: num(lastStatus?.gasApt),
    txCount: num(lastStatus?.txCount),
    outcome,
    reason,
    residual,
  };
}

export interface DashboardData {
  generatedAt: number;
  logLines: number;
  window: { from: number; to: number; ms: number | null };
  market: string | null;
  run: {
    state: RunState;
    detail: string;
    dryRun: boolean;
    network: string | null;
    markets: string[];
    startedAt: number | null;
    lastLogAt: number | null;
    /** Seconds since the last sign of life (log line or live snapshot). */
    ageSec: number | null;
    uptimeSec: number | null;
    liveSeen: boolean;
    /** Start time of the run being shown, and whether it is the newest one. */
    id: number | null;
    isLatest: boolean;
    /** Planned end (epoch ms) when the run was started with a duration. */
    endsAt: number | null;
    remainingSec: number | null;
    /** How the run ended, once it has: the reason and whether every position was closed. */
    finish: { reason: string; closed: boolean; residual: Record<string, number>; dust: Record<string, number> } | null;
  };
  /** The run history, newest first. */
  runs: RunSummary[];
  alerts: Alert[];
  config: { marketCfg: unknown[]; limits: Record<string, unknown> };
  latest: Record<string, unknown> | null;
  markets: MarketView[];
  series: {
    t: number[];
    equity: (number | null)[];
    positionUsd: (number | null)[];
    positionUsdByMarket: Record<string, (number | null)[]>;
    aptBalance: (number | null)[];
    pnlBps: (number | null)[];
    cycleMakerRatio: (number | null)[];
  };
  volumeSeries: { t: number[]; cumUsd: number[]; makerUsd: number[] };
  volumeByMarket: Record<string, { t: number[]; cumUsd: number[] }>;
  fills: {
    total: number;
    maker: number;
    taker: number;
    buys: number;
    sells: number;
    volumeUsd: number;
    makerVolumeUsd: number;
    feesUsd: number;
    recent: FillRow[];
  };
  ladders: {
    placed: number;
    dry: number;
    failed: number;
    perHour: number | null;
    total: number;
    recent: {
      t: number;
      market: string;
      dry: boolean;
      seq: number | null;
      hash: string | null;
      gasUsed: number | null;
      path: string | null;
    }[];
  };
  events: { total: number; rows: { t: number; level: string; msg: string; market: string | null; detail: string }[] };
  counters: { warn: number; error: number; fuseTrips: number; pauses: number };
  /** Account-wide economics for the selected window (not filtered by market). */
  econ: {
    equityStart: number | null;
    equityNow: number | null;
    equityDelta: number | null;
    volumeUsd: number;
    feesUsd: number;
    feeBps: number | null;
    grossPnlUsd: number | null;
    grossPnlBps: number | null;
    rebateBps: number;
    rebateUsd: number;
    gasApt: number | null;
    gasAptRun: number | null;
    gasUsd: number | null;
    gasBps: number | null;
    netUsd: number | null;
    txCount: number | null;
    txCountRun: number | null;
    gasAptPerHour: number | null;
    aptBalance: number | null;
    aptRunwayHours: number | null;
    aptUsd: number;
  };
  /** Filled in by the server: whether the Start/End buttons exist and the bot's process state. */
  control?: unknown;
  /** Status file of the 24/7 supervisor, if one has run here. */
  supervisor?: Record<string, unknown> | null;
  /** Filled in by the server. */
  aptPrice?: { usd: number; source: string; ts: number; ageSec: number; stale: boolean } | null;
}

/**
 * `src` is either the plain list of lines (tests, one-off use) or a {@link LogIndex} kept up to date by the server, which
 * is what makes a request cost the size of the window asked for instead of the size of the whole log.
 */
export function analyze(src: LogLine[] | LogIndex, o: AnalyzeOpts): DashboardData {
  const maxPts = o.maxSeriesPoints ?? 600;
  const maxRows = o.maxRows ?? 200;
  const idx = src instanceof LogIndex ? src : LogIndex.from(src);
  const runsAll = idx.all;
  const latestRun = runsAll.length ? runsAll[runsAll.length - 1]! : null;
  const picked = o.runStart != null ? runsAll.find((r) => r.startedAt === o.runStart) : undefined;
  const run = picked ?? latestRun ?? new RunIndex(null);
  const isLatest = picked === undefined || picked === latestRun;
  const start = run.start;
  const last = run.lastLine;
  const startedAt = run.startedAt;
  const dryRun = start?.dryRun === true;
  const limits = rec(start?.limits);
  const marketCfg = Array.isArray(start?.marketCfg) ? (start!.marketCfg as unknown[]) : [];
  const startMarkets = Array.isArray(start?.markets) ? (start!.markets as unknown[]).map(String) : [];

  // --- live snapshot (1 s) -------------------------------------------------------------------
  let live: Record<string, unknown> | null = null;
  let liveTs: number | null = null;
  if (isLatest && o.live && typeof o.live.t === "string") {
    const ts = Date.parse(o.live.t);
    const samePid = start?.pid === undefined || o.live.pid === start.pid;
    const thisRun = startedAt === null || ts >= startedAt - 1000;
    if (Number.isFinite(ts) && samePid && thisRun) {
      live = o.live;
      liveTs = ts;
    }
  }

  const lastStatus = run.lastStatus;
  const liveNewer = live !== null && liveTs !== null && (lastStatus === null || liveTs >= lastStatus.ts);
  const latest: Record<string, unknown> | null = liveNewer
    ? (({ markets: _m, ...rest }) => rest)(live as Record<string, unknown>)
    : lastStatus
      ? { ...lastStatus }
      : null;
  const first = run.firstStatus;

  // --- state -----------------------------------------------------------------------------------
  const lastActivity = Math.max(last?.ts ?? -Infinity, liveTs ?? -Infinity);
  const hasActivity = Number.isFinite(lastActivity);
  const haltLine = run.halt;
  const stopped = run.stopped;
  const endingLine = run.ending;
  const finishedLine = run.finished;
  const finish = finishedLine
    ? {
        reason: String(finishedLine.reason ?? ""),
        closed: finishedLine.flat === true,
        residual: numOnly(finishedLine.residual),
        dust: numOnly(finishedLine.dust),
      }
    : null;
  const ageMs = hasActivity ? o.now - lastActivity : null;
  const staleAfter = liveTs !== null ? (o.liveStaleMs ?? 15_000) : o.staleMs;
  const reasonText = (r: string): string => (r === "deadline" ? "hết giờ" : r === "stop" ? "bạn bấm Kết thúc" : r);
  let state: RunState;
  let detail: string;
  if (!hasActivity) {
    state = "no-data";
    detail = "Chưa có log. Hãy chạy bot (live hoặc live --dry-run).";
  } else if (haltLine || (!stopped && run.haltedExit)) {
    state = "halted";
    detail = `Bot tự dừng: ${String(haltLine?.reason ?? "xem Sự kiện")}`;
  } else if (finish) {
    state = "stopped";
    detail = finish.closed
      ? `Đã kết thúc (${reasonText(finish.reason)}): toàn bộ vị thế đã đóng.`
      : `Đã kết thúc (${reasonText(finish.reason)}) nhưng CÒN vị thế chưa đóng: ${JSON.stringify(finish.residual)}`;
  } else if (stopped) {
    state = "stopped";
    detail = "Bot đã dừng sạch (đã hủy lệnh, vị thế giữ nguyên).";
  } else if (!isLatest) {
    state = "stopped";
    detail = "Phiên cũ: kết thúc không có dòng kết thúc (dừng bằng tín hiệu, mất điện, hoặc tiến trình chết).";
  } else if (ageMs !== null && ageMs > staleAfter) {
    state = "stale";
    detail = `Không có tín hiệu mới trong ${Math.round(ageMs / 1000)} giây: tiến trình có thể đã chết${endingLine ? " khi đang đóng vị thế" : ""}.`;
  } else if (endingLine || live?.phase === "flattening") {
    state = "finishing";
    detail = "Đang hủy lệnh và đóng toàn bộ vị thế.";
  } else {
    state = "running";
    detail = dryRun ? "Đang chạy thử (không gửi giao dịch)." : "Đang chạy thật.";
  }
  const endsAtMs = num(live?.endsAt) ?? (typeof start?.endsAt === "string" ? Date.parse(start.endsAt) : null);
  const endsAt = endsAtMs !== null && Number.isFinite(endsAtMs) ? endsAtMs : null;
  const remainingSec = endsAt !== null && (state === "running" || state === "finishing") ? Math.max(0, Math.round((endsAt - o.now) / 1000)) : null;

  // --- window ----------------------------------------------------------------------------------
  const end = hasActivity ? lastActivity : o.now;
  const runStart = startedAt ?? end;
  const from = o.rangeMs ? Math.max(end - o.rangeMs, runStart) : runStart;
  const inWin = (l: LogLine): boolean => l.ts >= from;
  const mkt = o.market ?? null;
  const hours = Math.max((end - from) / 3_600_000, 1e-9);

  // --- series (account level; positions per market) ---------------------------------------------
  const inWindow = run.window("statuses", from);
  const anchor = o.rangeMs ? run.lastBefore("statuses", from) : null;
  const pts: Record<string, unknown>[] = [...(anchor ? [{ ...anchor, ts: from }] : []), ...inWindow];
  if (live && liveTs !== null && liveNewer && liveTs >= from) pts.push({ ...live, ts: liveTs });
  const st = thin(pts, maxPts);
  const sumUsd = (l: Record<string, unknown>): number | null => {
    const v = Object.values(numRecord(l.positionsUsd)).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };

  const fillLinesAll = run.window("fills", from);
  const fillLines = mkt ? fillLinesAll.filter((l) => l.market === mkt) : fillLinesAll;

  const names: string[] = [];
  const addName = (n: unknown): void => {
    if (typeof n === "string" && n && !names.includes(n)) names.push(n);
  };
  startMarkets.forEach(addName);
  Object.keys(rec(live?.markets)).forEach(addName);
  Object.keys(rec(latest?.positions)).forEach(addName);
  fillLinesAll.forEach((l) => addName(l.market));
  const shownNames = mkt ? names.filter((n) => n === mkt) : names;

  const series = {
    t: st.map((l) => l.ts as number),
    equity: st.map((l) => num(l.equity)),
    positionUsd: st.map((l) => (mkt ? (numRecord(l.positionsUsd)[mkt] ?? null) : sumUsd(l))),
    positionUsdByMarket: Object.fromEntries(shownNames.map((n) => [n, st.map((l) => numRecord(l.positionsUsd)[n] ?? null)])),
    aptBalance: st.map((l) => num(l.signerAptBalance)),
    pnlBps: st.map((l) => num(l.pnlBps)),
    cycleMakerRatio: st.map((l) => num(l.cycleMakerRatio)),
  };

  // --- fills -----------------------------------------------------------------------------------
  const sumFills = (lines: LogLine[]) => {
    const a = { total: lines.length, maker: 0, taker: 0, buys: 0, sells: 0, volumeUsd: 0, makerVolumeUsd: 0, feesUsd: 0 };
    for (const l of lines) {
      const usd = (num(l.px) ?? 0) * (num(l.sz) ?? 0);
      const maker = l.maker === true;
      if (maker) a.maker++;
      else a.taker++;
      if (l.side === "buy") a.buys++;
      else a.sells++;
      a.volumeUsd += usd;
      if (maker) a.makerVolumeUsd += usd;
      a.feesUsd += num(l.fee) ?? 0;
    }
    return a;
  };
  const fillsAll = sumFills(fillLinesAll);
  const fills = {
    ...sumFills(fillLines),
    recent: fillLines
      .slice(-maxRows)
      .reverse()
      .map((l): FillRow => {
        const px = num(l.px) ?? 0;
        const sz = num(l.sz) ?? 0;
        return { t: l.ts, market: String(l.market ?? ""), side: String(l.side ?? ""), px, sz, usd: px * sz, maker: l.maker === true, fee: num(l.fee) ?? 0 };
      }),
  };

  const cumulative = (lines: LogLine[]) => {
    const t: number[] = [from];
    const cum: number[] = [0];
    const mk: number[] = [0];
    let cv = 0;
    let cm = 0;
    for (const l of lines) {
      const usd = (num(l.px) ?? 0) * (num(l.sz) ?? 0);
      cv += usd;
      if (l.maker === true) cm += usd;
      t.push(l.ts);
      cum.push(cv);
      mk.push(cm);
    }
    if (t[t.length - 1]! < end) {
      t.push(end);
      cum.push(cv);
      mk.push(cm);
    }
    return { t, cum, mk };
  };
  const vAll = cumulative(fillLines);
  const volumeSeries = { t: thin(vAll.t, maxPts), cumUsd: thin(vAll.cum, maxPts), makerUsd: thin(vAll.mk, maxPts) };
  const volumeByMarket: DashboardData["volumeByMarket"] = {};
  for (const n of shownNames) {
    const c = cumulative(fillLinesAll.filter((l) => l.market === n));
    volumeByMarket[n] = { t: thin(c.t, maxPts), cumUsd: thin(c.cum, maxPts) };
  }

  // --- ladders / transactions ------------------------------------------------------------------
  const placedWin = run.window("placed", from).filter((l) => !mkt || l.market === mkt);
  const failed = run.window("failed", from).filter((l) => !mkt || l.market === mkt).length;
  const quotesOf = (l: LogLine): { bids: number[][]; asks: number[][] } | null => {
    const q = rec(l.quotes);
    return Array.isArray(q.bids) && Array.isArray(q.asks) ? { bids: q.bids as number[][], asks: q.asks as number[][] } : null;
  };
  const ladders = {
    placed: placedWin.filter((l) => l.msg === "ladder placed").length,
    dry: placedWin.filter((l) => l.msg !== "ladder placed").length,
    failed,
    total: placedWin.length,
    perHour: hours > 0.01 ? placedWin.length / hours : null,
    recent: placedWin
      .slice(-maxRows)
      .reverse()
      .map((l) => ({
        t: l.ts,
        market: String(l.market ?? ""),
        dry: l.msg !== "ladder placed",
        seq: num(l.sequenceNumber),
        hash: typeof l.hash === "string" ? l.hash : null,
        gasUsed: l.gasUsed === undefined ? null : Number(l.gasUsed),
        path: typeof l.path === "string" ? l.path : null,
      })),
  };

  // --- events ----------------------------------------------------------------------------------
  const ofMarket = (l: LogLine): boolean => !mkt || l.market === undefined || l.market === mkt;
  const notable = run.window("notable", from).filter(ofMarket);
  const events = {
    total: notable.length,
    rows: notable
      .slice(-maxRows)
      .reverse()
      .map((l) => ({ t: l.ts, level: l.level, msg: l.msg, market: typeof l.market === "string" ? l.market : null, detail: detailOf(l) })),
  };
  const counters = {
    warn: run.window("warns", from).filter(ofMarket).length,
    error: run.window("errors", from).filter(ofMarket).length,
    fuseTrips: run.window("trips", from).filter(ofMarket).length,
    pauses: run.window("pauses", from).filter(ofMarket).length,
  };

  // --- economics (account-wide, selected window) -----------------------------------------------
  const base = run.lastBefore("statuses", from, true);
  const rebateBps = num(limits.rebateBps) ?? 0.5;
  const equityNow = num(latest?.equity);
  const equityStart = base ? num(base.equity) : (num(latest?.startEquity) ?? num(first?.equity));
  const equityDelta = equityNow !== null && equityStart !== null ? equityNow - equityStart : null;
  const gasRun = num(latest?.gasApt);
  const gasApt = gasRun !== null ? gasRun - (base ? (num(base.gasApt) ?? 0) : 0) : null;
  const txRun = num(latest?.txCount);
  const txCount = txRun !== null ? txRun - (base ? (num(base.txCount) ?? 0) : 0) : null;
  const gasUsd = gasApt !== null ? gasApt * o.aptUsd : null;
  const rebateUsd = (fillsAll.makerVolumeUsd * rebateBps) / 1e4;
  const vol = fillsAll.volumeUsd;
  const gasAptPerHour = gasApt !== null && hours > 0.01 ? gasApt / hours : null;
  const aptBalance = num(latest?.signerAptBalance);
  const econ = {
    equityStart,
    equityNow,
    equityDelta,
    volumeUsd: vol,
    feesUsd: fillsAll.feesUsd,
    feeBps: vol > 0 ? (fillsAll.feesUsd / vol) * 1e4 : null,
    grossPnlUsd: equityDelta !== null ? equityDelta + fillsAll.feesUsd : null,
    grossPnlBps: equityDelta !== null && vol > 0 ? ((equityDelta + fillsAll.feesUsd) / vol) * 1e4 : null,
    rebateBps,
    rebateUsd,
    gasApt,
    gasAptRun: gasRun,
    gasUsd,
    gasBps: gasUsd !== null && vol > 0 ? (gasUsd / vol) * 1e4 : null,
    netUsd: equityDelta !== null && gasUsd !== null ? equityDelta + rebateUsd - gasUsd : null,
    txCount,
    txCountRun: txRun,
    gasAptPerHour,
    aptBalance,
    aptRunwayHours: aptBalance !== null && gasAptPerHour !== null && gasAptPerHour > 0 ? aptBalance / gasAptPerHour : null,
    aptUsd: o.aptUsd,
  };

  // --- per-market views ------------------------------------------------------------------------
  const sizeMult = num(latest?.sizeMult) ?? 1;
  const liveMarkets = rec(live?.markets);
  const marketViews: MarketView[] = shownNames.map((name) => {
    const lv = rec(liveMarkets[name]);
    const cfgM = rec(marketCfg.find((m) => rec(m).name === name));
    const capBase = num(cfgM.maxPositionUsd);
    const lastLadder = run.lastQuoted.get(name) ?? null;
    const liveQuotes = lv.quotes && typeof lv.quotes === "object" ? (lv.quotes as { bids: number[][]; asks: number[][] }) : null;
    const fl = fillLinesAll.filter((l) => l.market === name);
    const s = sumFills(fl);
    const pausedLive = lv.paused;
    return {
      name,
      mid: num(lv.mid) ?? num(rec(latest?.mids)[name]),
      bid: num(lv.bid),
      ask: num(lv.ask),
      spreadBps: num(lv.spreadBps),
      position: num(lv.position) ?? num(rec(latest?.positions)[name]),
      positionUsd: num(lv.positionUsd) ?? num(rec(latest?.positionsUsd)[name]),
      capUsd: num(lv.capUsd) ?? (capBase !== null ? capBase * sizeMult : null),
      quoting: typeof lv.quoting === "boolean" ? lv.quoting : typeof rec(latest?.quoting)[name] === "boolean" ? (rec(latest?.quoting)[name] as boolean) : null,
      paused: typeof pausedLive === "string" ? pausedLive : typeof rec(latest?.paused)[name] === "string" ? (rec(latest?.paused)[name] as string) : null,
      fuse: typeof lv.fuse === "string" ? lv.fuse : null,
      fuseUntil: num(lv.fuseUntil),
      fuseReason: typeof lv.fuseReason === "string" ? lv.fuseReason : null,
      quotes: liveQuotes ?? (lastLadder ? quotesOf(lastLadder) : null),
      quotesAt: liveQuotes ? liveTs : (lastLadder?.ts ?? null),
      fills: s.total,
      maker: s.maker,
      taker: s.taker,
      volumeUsd: s.volumeUsd,
      makerVolumeUsd: s.makerVolumeUsd,
      feesUsd: s.feesUsd,
    };
  });

  // --- alerts ----------------------------------------------------------------------------------
  const alerts: Alert[] = [];
  if (state === "stale")
    alerts.push({
      level: "error",
      text: `${detail} Nếu bot đã chết, lệnh có thể VẪN nằm trên chuỗi: vào app Decibel > Open Orders để hủy.`,
    });
  if (state === "finishing") alerts.push({ level: "info", text: "Đang hủy lệnh và đóng toàn bộ vị thế. Đừng tắt bot hay máy ảo lúc này." });
  if (finish && !finish.closed)
    alerts.push({ level: "error", text: `Bot đã kết thúc nhưng còn vị thế chưa đóng: ${JSON.stringify(finish.residual)}. Mở Positions trong app Decibel và đóng thủ công.` });
  if (finish && Object.keys(finish.dust).length)
    alerts.push({ level: "warn", text: `Còn vị thế quá nhỏ để đóng bằng lệnh thường (dưới lệnh tối thiểu): ${JSON.stringify(finish.dust)}.` });
  if (state === "halted") alerts.push({ level: "error", text: `${detail}. Kiểm tra Open Orders trong app xem còn lệnh nào không.` });
  if (o.killFile) alerts.push({ level: "warn", text: "File state/KILL đang tồn tại: bot sẽ dừng và hủy lệnh (xóa file nếu muốn chạy lại)." });
  if (state === "running" && latest) {
    const runFills = run.fillCount;
    const ratio = num(latest.cycleMakerRatio);
    const minRatio = num(limits.minMakerRatio) ?? 0.8;
    if (ratio !== null && runFills >= 3 && ratio < minRatio)
      alerts.push({ level: "warn", text: `Tỷ lệ maker của chu kỳ ${(ratio * 100).toFixed(1)}% thấp hơn ${(minRatio * 100).toFixed(0)}%: không đủ điều kiện nhận rebate.` });
    const taker = num(latest.takerFills) ?? 0;
    if (taker > 0) alerts.push({ level: "warn", text: `${taker} lệnh khớp kiểu taker trong phiên (trả phí taker, kéo tỷ lệ maker xuống).` });
    const minGas = num(limits.minGasBalanceApt);
    if (aptBalance !== null && minGas !== null && aptBalance < minGas * 2)
      alerts.push({ level: "warn", text: `Số dư APT của ví ký chỉ còn ${aptBalance.toFixed(4)} (ngưỡng dừng ${minGas}). Nạp thêm APT.` });
    // Drawdown is measured against the start of the run, whatever window is selected.
    const runStartEquity = num(latest.startEquity) ?? num(first?.equity);
    const maxDd = num(limits.maxDrawdownUsd);
    if (maxDd !== null && runStartEquity !== null && equityNow !== null && runStartEquity - equityNow > maxDd * 0.5)
      alerts.push({ level: "warn", text: `Vốn đã giảm ${(runStartEquity - equityNow).toFixed(2)} USD, bằng ${(((runStartEquity - equityNow) / maxDd) * 100).toFixed(0)}% ngưỡng dừng ${maxDd} USD.` });
    for (const m of names) {
      const p = rec(liveMarkets[m]).paused ?? rec(latest.paused)[m];
      if (typeof p === "string") alerts.push({ level: "warn", text: `${m} đang tạm dừng báo giá: ${p}` });
    }
    if (latest.phase === "paused")
      alerts.push({ level: "error", text: "Đã chạm giới hạn lỗ trong ngày: bot đã đóng vị thế và đứng ngoài thị trường đến hết ngày UTC, rồi sẽ tự giao dịch lại." });
    const runway = num(latest.gasRunwayDays);
    if (runway !== null && runway < 3) alerts.push({ level: runway < 1 ? "error" : "warn", text: `APT trong ví ký chỉ đủ ~${runway} ngày gas ở tốc độ hiện tại. Nạp thêm APT.` });
    const econ = num(latest.economy);
    if (econ !== null && econ > 1.2) alerts.push({ level: "info", text: `Chế độ tiết kiệm gas x${econ}: gas đang vượt nhịp ngân sách ngày nên bot đặt lại lệnh thưa hơn.` });
    const cross = num(latest.takerCross);
    if (cross !== null && cross > 0) alerts.push({ level: "warn", text: `${cross} lệnh đang treo bị khớp kiểu taker do giá chạy tới trước khi lệnh được ghi nhận (tự nới khoảng cách an toàn: ${num(latest.guardTicks) ?? 0} tick).` });
    const lastTrip = run.lastTrip;
    if (lastTrip) {
      const until = lastTrip.ts + (num(lastTrip.pauseSec) ?? 0) * 1000;
      if (o.now < until)
        alerts.push({ level: "warn", text: `Cầu chì${typeof lastTrip.market === "string" ? " " + lastTrip.market : ""} đang ngắt (còn ${Math.ceil((until - o.now) / 1000)} giây): ${String(lastTrip.reason ?? "")}` });
    }
  }
  if (state === "running" && !latest && last) alerts.push({ level: "info", text: "Bot vừa khởi động, chưa có dòng status đầu tiên." });

  return {
    generatedAt: o.now,
    logLines: idx.total,
    window: { from, to: end, ms: o.rangeMs ?? null },
    market: mkt,
    run: {
      state,
      detail,
      dryRun,
      network: typeof start?.network === "string" ? start.network : null,
      markets: names,
      startedAt,
      lastLogAt: last?.ts ?? null,
      ageSec: ageMs !== null ? Math.round(ageMs / 1000) : null,
      uptimeSec: startedAt !== null && hasActivity ? Math.round(((state === "running" ? o.now : lastActivity) - startedAt) / 1000) : null,
      liveSeen: liveTs !== null,
      id: startedAt,
      isLatest,
      endsAt,
      remainingSec,
      finish,
    },
    // Only the 40 newest runs are summarised: a 24/7 session can have hundreds of restarts.
    runs: runsAll
      .slice(-40)
      .map((r, k, part) => {
        const i = runsAll.length - part.length + k;
        // A supervised process that ended without a closing line and was followed by the next attempt crashed and was restarted.
        const a = attemptOf(r);
        const next = i + 1 < runsAll.length ? attemptOf(runsAll[i + 1]!) : null;
        return summarizeIdx(r, i === runsAll.length - 1, o.now, o.staleMs, a !== null && next === a + 1);
      })
      .reverse(),
    alerts,
    config: { marketCfg, limits },
    latest,
    markets: marketViews,
    series,
    volumeSeries,
    volumeByMarket,
    fills,
    ladders,
    events,
    counters,
    econ,
  };
}
