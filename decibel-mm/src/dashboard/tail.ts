import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { LogIndex, parseLog } from "./analyze.js";
import type { LogLine } from "./analyze.js";

export interface LogTailOpts {
  /**
   * Also keep every parsed line in a plain array for {@link LogTail.read}. The dashboard server does not: it reads the
   * index, which holds only what the page shows and so stays small over weeks of 24/7 logging. Default true.
   */
  keepLines?: boolean;
}

/**
 * Follows the bot's JSON-lines log. The first read takes only the last `initialBytes` of the file;
 * after that every call parses just the bytes appended since, so polling once a second stays cheap
 * however long the run gets. Earlier runs stay in memory (up to `maxLines` lines) so the dashboard can show the history.
 */
export class LogTail {
  private lines: LogLine[] = [];
  private idx = new LogIndex();
  private readonly keepLines: boolean;
  private offset = 0;
  private ino = -1;
  private started = false;

  constructor(
    private readonly file: string,
    private readonly initialBytes = 24_000_000,
    private readonly maxLines = 150_000,
    opts: LogTailOpts = {},
  ) {
    this.keepLines = opts.keepLines ?? true;
  }

  /** Every line seen so far (up to `maxLines`). The array is replaced, never mutated, between calls. */
  read(): LogLine[] {
    this.poll();
    return this.lines;
  }

  /** The incrementally built index over the same lines: what the dashboard analyses. */
  readIndex(): LogIndex {
    this.poll();
    return this.idx;
  }

  private poll(): void {
    if (!existsSync(this.file)) {
      this.reset();
      return;
    }
    const st = statSync(this.file);
    if (st.ino !== this.ino || st.size < this.offset) {
      this.reset();
      this.ino = st.ino;
    }
    if (!this.started) {
      this.started = true;
      this.offset = Math.max(0, st.size - this.initialBytes);
      const buf = this.slice(this.offset, st.size);
      let skip = 0;
      if (this.offset > 0) {
        const nl = buf.indexOf(0x0a);
        skip = nl >= 0 ? nl + 1 : buf.length; // drop the line the cut landed in
      }
      this.consume(buf.subarray(skip), this.offset + skip);
      return;
    }
    if (st.size > this.offset) this.consume(this.slice(this.offset, st.size), this.offset);
  }

  private reset(): void {
    this.lines = [];
    this.idx = new LogIndex();
    this.offset = 0;
    this.ino = -1;
    this.started = false;
  }

  private slice(from: number, to: number): Buffer {
    if (to <= from) return Buffer.alloc(0);
    const fd = openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(to - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }

  /** Parse the complete lines in `buf` (which starts at file position `at`); leave a partial last line for next time. */
  private consume(buf: Buffer, at: number): void {
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) {
      this.offset = at;
      return;
    }
    const fresh = parseLog(buf.subarray(0, end + 1).toString("utf8"));
    this.offset = at + end + 1;
    if (!fresh.length) return;
    this.idx.add(fresh);
    this.idx.trim(this.maxLines);
    if (this.keepLines) {
      const all = this.lines.concat(fresh);
      this.lines = all.length > this.maxLines ? all.slice(all.length - this.maxLines) : all;
    }
  }
}

/** live.json, cached by modification time. null when missing or unreadable. */
export class LiveFile {
  private key = "";
  private value: Record<string, unknown> | null = null;

  constructor(private readonly file: string) {}

  read(): Record<string, unknown> | null {
    if (!this.file || !existsSync(this.file)) return null;
    try {
      const s = statSync(this.file);
      const key = `${s.size}:${s.mtimeMs}`;
      if (key !== this.key) {
        const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
        this.value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        this.key = key;
      }
      return this.value;
    } catch {
      return this.value; // mid-rename or partial read: keep the last good snapshot
    }
  }
}
