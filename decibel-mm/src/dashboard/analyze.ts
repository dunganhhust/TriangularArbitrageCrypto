/**
 * Turns the bot's JSON-lines run log into the numbers the dashboard shows. Pure: no I/O, the
 * clock is passed in, so it is covered by unit tests.
 */

export interface LogLine {
  t: string;
  ts: number;
  level: string;
  msg: string;
  [k: string]: unknown;
}

export type RunState = "no-data" | "running" | "stale" | "stopped" | "halted";

export interface Alert {
  level: "error" | "warn" | "info";
  text: string;
}

export interface AnalyzeOpts {
  now: number;
  /** A run with no log line for this long is reported as stale (process probably dead). */
  staleMs: number;
  /** USD price of 1 APT, used only to turn gas into dollars. */
  aptUsd: number;
  /** Whether the KILL file exists right now. */
  killFile: boolean;
  maxSeriesPoints?: number;
  maxRows?: number;
}

const STOP_MSG = "shutting down, cancelling quotes";

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

/** Lines of the most recent run: everything from the last "market maker started" marker. */
export function lastRun(lines: LogLine[]): LogLine[] {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.msg === "market maker started") return lines.slice(i);
  return lines;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

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

export interface DashboardData {
  generatedAt: number;
  logLines: number;
  run: {
    state: RunState;
    detail: string;
    dryRun: boolean;
    network: string | null;
    markets: string[];
    startedAt: number | null;
    lastLogAt: number | null;
    ageSec: number | null;
    uptimeSec: number | null;
  };
  alerts: Alert[];
  config: { marketCfg: unknown[]; limits: Record<string, unknown> };
  latest: Record<string, unknown> | null;
  series: {
    t: number[];
    equity: (number | null)[];
    positionUsd: (number | null)[];
    aptBalance: (number | null)[];
    pnlBps: (number | null)[];
    cycleMakerRatio: (number | null)[];
  };
  volumeSeries: { t: number[]; cumUsd: number[]; makerUsd: number[] };
  fills: {
    total: number;
    maker: number;
    taker: number;
    buys: number;
    sells: number;
    volumeUsd: number;
    makerVolumeUsd: number;
    feesUsd: number;
    recent: { t: number; market: string; side: string; px: number; sz: number; usd: number; maker: boolean; fee: number }[];
  };
  ladders: {
    placed: number;
    dry: number;
    failed: number;
    perHour: number | null;
    recent: {
      t: number;
      market: string;
      dry: boolean;
      seq: number | null;
      hash: string | null;
      gasUsed: number | null;
      path: string | null;
      quotes: { bids: number[][]; asks: number[][] } | null;
    }[];
  };
  events: { t: number; level: string; msg: string; detail: string }[];
  counters: { warn: number; error: number; fuseTrips: number; pauses: number };
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
    gasUsd: number | null;
    gasBps: number | null;
    netUsd: number | null;
    txCount: number | null;
    gasAptPerHour: number | null;
    aptBalance: number | null;
    aptRunwayHours: number | null;
    aptUsd: number;
  };
}

export function analyze(all: LogLine[], o: AnalyzeOpts): DashboardData {
  const maxPts = o.maxSeriesPoints ?? 600;
  const maxRows = o.maxRows ?? 40;
  const run = lastRun(all);
  const start = run.find((l) => l.msg === "market maker started") ?? null;
  const last = run.length ? run[run.length - 1]! : null;
  const startedAt = start?.ts ?? run[0]?.ts ?? null;
  const dryRun = start?.dryRun === true;
  const limits = rec(start?.limits);
  const marketCfg = Array.isArray(start?.marketCfg) ? (start!.marketCfg as unknown[]) : [];
  const markets = Array.isArray(start?.markets) ? (start!.markets as unknown[]).map(String) : [];

  const statuses = run.filter((l) => l.msg === "status");
  const latest = statuses.length ? statuses[statuses.length - 1]! : null;
  const first = statuses.length ? statuses[0]! : null;

  // --- state -----------------------------------------------------------------------------------
  const haltLine = [...run].reverse().find((l) => l.level === "error" && l.msg === "HALT") ?? null;
  const stopped = run.some((l) => l.msg === STOP_MSG);
  const ageMs = last ? o.now - last.ts : null;
  let state: RunState;
  let detail: string;
  if (!last) {
    state = "no-data";
    detail = "Chưa có log. Hãy chạy bot (live hoặc live --dry-run).";
  } else if (haltLine || run.some((l) => l.msg === "halted; exiting")) {
    state = "halted";
    detail = `Bot tự dừng: ${String(haltLine?.reason ?? "xem Sự kiện")}`;
  } else if (stopped) {
    state = "stopped";
    detail = "Bot đã dừng sạch (đã hủy lệnh).";
  } else if (ageMs !== null && ageMs > o.staleMs) {
    state = "stale";
    detail = `Không có log mới trong ${Math.round(ageMs / 1000)} giây: tiến trình có thể đã chết.`;
  } else {
    state = "running";
    detail = dryRun ? "Đang chạy thử (không gửi giao dịch)." : "Đang chạy thật.";
  }

  // --- series ----------------------------------------------------------------------------------
  const st = thin(statuses, maxPts);
  const sumUsd = (l: LogLine): number | null => {
    const v = Object.values(numRecord(l.positionsUsd)).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const series = {
    t: st.map((l) => l.ts),
    equity: st.map((l) => num(l.equity)),
    positionUsd: st.map(sumUsd),
    aptBalance: st.map((l) => num(l.signerAptBalance)),
    pnlBps: st.map((l) => num(l.pnlBps)),
    cycleMakerRatio: st.map((l) => num(l.cycleMakerRatio)),
  };

  // --- fills -----------------------------------------------------------------------------------
  const fillLines = run.filter((l) => l.msg === "fill");
  const fills = {
    total: fillLines.length,
    maker: 0,
    taker: 0,
    buys: 0,
    sells: 0,
    volumeUsd: 0,
    makerVolumeUsd: 0,
    feesUsd: 0,
    recent: [] as DashboardData["fills"]["recent"],
  };
  const cum: number[] = [];
  const cumMaker: number[] = [];
  const cumT: number[] = [];
  let cv = 0;
  let cm = 0;
  if (startedAt !== null) {
    cumT.push(startedAt);
    cum.push(0);
    cumMaker.push(0);
  }
  for (const l of fillLines) {
    const px = num(l.px) ?? 0;
    const sz = num(l.sz) ?? 0;
    const usd = px * sz;
    const maker = l.maker === true;
    if (maker) fills.maker++;
    else fills.taker++;
    if (l.side === "buy") fills.buys++;
    else fills.sells++;
    fills.volumeUsd += usd;
    if (maker) fills.makerVolumeUsd += usd;
    fills.feesUsd += num(l.fee) ?? 0;
    cv += usd;
    if (maker) cm += usd;
    cumT.push(l.ts);
    cum.push(cv);
    cumMaker.push(cm);
  }
  if (last && cumT.length && cumT[cumT.length - 1]! < last.ts) {
    cumT.push(last.ts);
    cum.push(cv);
    cumMaker.push(cm);
  }
  fills.recent = fillLines
    .slice(-maxRows)
    .reverse()
    .map((l) => ({
      t: l.ts,
      market: String(l.market ?? ""),
      side: String(l.side ?? ""),
      px: num(l.px) ?? 0,
      sz: num(l.sz) ?? 0,
      usd: (num(l.px) ?? 0) * (num(l.sz) ?? 0),
      maker: l.maker === true,
      fee: num(l.fee) ?? 0,
    }));
  const volumeSeries = {
    t: thin(cumT, maxPts),
    cumUsd: thin(cum, maxPts),
    makerUsd: thin(cumMaker, maxPts),
  };

  // --- ladders ---------------------------------------------------------------------------------
  const placedLines = run.filter((l) => l.msg === "ladder placed" || l.msg === "DRY-RUN place_bulk_orders");
  const ladders = {
    placed: placedLines.filter((l) => l.msg === "ladder placed").length,
    dry: placedLines.filter((l) => l.msg !== "ladder placed").length,
    failed: run.filter((l) => l.msg === "bulk order tx failed" || l.msg === "bulk order tx error" || l.msg === "replace failed").length,
    perHour: null as number | null,
    recent: placedLines
      .slice(-12)
      .reverse()
      .map((l) => {
        const q = rec(l.quotes);
        return {
          t: l.ts,
          market: String(l.market ?? ""),
          dry: l.msg !== "ladder placed",
          seq: num(l.sequenceNumber),
          hash: typeof l.hash === "string" ? l.hash : null,
          gasUsed: l.gasUsed === undefined ? null : Number(l.gasUsed),
          path: typeof l.path === "string" ? l.path : null,
          quotes: Array.isArray(q.bids) && Array.isArray(q.asks) ? { bids: q.bids as number[][], asks: q.asks as number[][] } : null,
        };
      }),
  };
  const hours = startedAt !== null && last ? Math.max((last.ts - startedAt) / 3_600_000, 1e-9) : null;
  if (hours !== null && hours > 0.01) ladders.perHour = placedLines.length / hours;

  // --- events ----------------------------------------------------------------------------------
  const notable = run.filter(
    (l) => l.level !== "info" || l.msg.startsWith("ramp:") || l.msg.startsWith("maker rebate") || l.msg === "market maker started",
  );
  const events = notable
    .slice(-60)
    .reverse()
    .map((l) => ({ t: l.ts, level: l.level, msg: l.msg, detail: detailOf(l) }));
  const counters = {
    warn: run.filter((l) => l.level === "warn").length,
    error: run.filter((l) => l.level === "error").length,
    fuseTrips: run.filter((l) => l.msg.startsWith("FUSE tripped")).length,
    pauses: run.filter((l) => l.msg === "pause").length,
  };

  // --- economics -------------------------------------------------------------------------------
  const rebateBps = num(limits.rebateBps) ?? 0.5;
  const equityNow = num(latest?.equity);
  const equityStart = num(latest?.startEquity) ?? num(first?.equity);
  const equityDelta = equityNow !== null && equityStart !== null ? equityNow - equityStart : null;
  const gasApt = num(latest?.gasApt);
  const gasUsd = gasApt !== null ? gasApt * o.aptUsd : null;
  const rebateUsd = (fills.makerVolumeUsd * rebateBps) / 1e4;
  const vol = fills.volumeUsd;
  const gasAptPerHour = gasApt !== null && hours !== null && hours > 0.01 ? gasApt / hours : null;
  const aptBalance = num(latest?.signerAptBalance);
  const econ = {
    equityStart,
    equityNow,
    equityDelta,
    volumeUsd: vol,
    feesUsd: fills.feesUsd,
    feeBps: vol > 0 ? (fills.feesUsd / vol) * 1e4 : null,
    grossPnlUsd: equityDelta !== null ? equityDelta + fills.feesUsd : null,
    grossPnlBps: equityDelta !== null && vol > 0 ? ((equityDelta + fills.feesUsd) / vol) * 1e4 : null,
    rebateBps,
    rebateUsd,
    gasApt,
    gasUsd,
    gasBps: gasUsd !== null && vol > 0 ? (gasUsd / vol) * 1e4 : null,
    netUsd: equityDelta !== null && gasUsd !== null ? equityDelta + rebateUsd - gasUsd : null,
    txCount: num(latest?.txCount),
    gasAptPerHour,
    aptBalance,
    aptRunwayHours: aptBalance !== null && gasAptPerHour !== null && gasAptPerHour > 0 ? aptBalance / gasAptPerHour : null,
    aptUsd: o.aptUsd,
  };

  // --- alerts ----------------------------------------------------------------------------------
  const alerts: Alert[] = [];
  if (state === "stale")
    alerts.push({
      level: "error",
      text: `${detail} Nếu bot đã chết, lệnh có thể VẪN nằm trên chuỗi: vào app Decibel > Open Orders để hủy.`,
    });
  if (state === "halted") alerts.push({ level: "error", text: `${detail}. Kiểm tra Open Orders trong app xem còn lệnh nào không.` });
  if (o.killFile) alerts.push({ level: "warn", text: "File state/KILL đang tồn tại: bot sẽ dừng và hủy lệnh (xóa file nếu muốn chạy lại)." });
  if (state === "running" && latest) {
    const ratio = num(latest.cycleMakerRatio);
    const minRatio = num(limits.minMakerRatio) ?? 0.8;
    if (ratio !== null && fills.total >= 3 && ratio < minRatio)
      alerts.push({ level: "warn", text: `Tỷ lệ maker của chu kỳ ${(ratio * 100).toFixed(1)}% thấp hơn ${(minRatio * 100).toFixed(0)}%: không đủ điều kiện nhận rebate.` });
    const taker = num(latest.takerFills) ?? 0;
    if (taker > 0) alerts.push({ level: "warn", text: `${taker} lệnh khớp kiểu taker trong phiên (trả phí taker, kéo tỷ lệ maker xuống).` });
    const minGas = num(limits.minGasBalanceApt);
    if (aptBalance !== null && minGas !== null && aptBalance < minGas * 2)
      alerts.push({ level: "warn", text: `Số dư APT của ví ký chỉ còn ${aptBalance.toFixed(4)} (ngưỡng dừng ${minGas}). Nạp thêm APT.` });
    const maxDd = num(limits.maxDrawdownUsd);
    if (maxDd !== null && equityDelta !== null && -equityDelta > maxDd * 0.5)
      alerts.push({ level: "warn", text: `Vốn đã giảm ${(-equityDelta).toFixed(2)} USD, bằng ${((-equityDelta / maxDd) * 100).toFixed(0)}% ngưỡng dừng ${maxDd} USD.` });
    for (const [m, p] of Object.entries(rec(latest.paused))) if (typeof p === "string") alerts.push({ level: "warn", text: `${m} đang tạm dừng báo giá: ${p}` });
    const lastTrip = [...run].reverse().find((l) => l.msg.startsWith("FUSE tripped")) ?? null;
    if (lastTrip) {
      const until = lastTrip.ts + (num(lastTrip.pauseSec) ?? 0) * 1000;
      if (o.now < until)
        alerts.push({ level: "warn", text: `Cầu chì đang ngắt (còn ${Math.ceil((until - o.now) / 1000)} giây): ${String(lastTrip.reason ?? "")}` });
    }
  }
  if (state === "running" && !latest && last) alerts.push({ level: "info", text: "Bot vừa khởi động, chưa có dòng status đầu tiên (30 giây một dòng)." });

  return {
    generatedAt: o.now,
    logLines: all.length,
    run: {
      state,
      detail,
      dryRun,
      network: typeof start?.network === "string" ? start.network : null,
      markets,
      startedAt,
      lastLogAt: last?.ts ?? null,
      ageSec: ageMs !== null ? Math.round(ageMs / 1000) : null,
      uptimeSec: startedAt !== null && last ? Math.round(((state === "running" ? o.now : last.ts) - startedAt) / 1000) : null,
    },
    alerts,
    config: { marketCfg, limits },
    latest: latest ? { ...latest } : null,
    series,
    volumeSeries,
    fills,
    ladders,
    events,
    counters,
    econ,
  };
}
