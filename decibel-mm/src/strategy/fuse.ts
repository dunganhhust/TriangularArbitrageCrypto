/**
 * Volatility circuit breaker ("fuse").
 *
 * Market makers lose money when the price jumps through resting quotes faster than they can
 * refresh them (every refresh here is an on-chain transaction). The fuse watches for the
 * conditions where that happens and, when tripped, tells the engine to pull all quotes. It then
 * pauses for a cool-down that doubles on repeated trips, lets quotes come back wider and
 * narrowing over a recovery period, and gives up for good if it keeps tripping.
 */

export interface FuseConfig {
  enabled: boolean;
  /** Trip when the price range over `fastWindowMs` exceeds this many bps. */
  fastMoveBps: number;
  fastWindowMs: number;
  /** Same, over a longer window, for slower grinding moves. */
  slowMoveBps: number;
  slowWindowMs: number;
  /** Trip when the book spread exceeds this (liquidity pulled). */
  spreadBps: number;
  /** Trip when book mid and oracle diverge by this. */
  oracleDevBps: number;
  /** Base pause after a trip; doubles for each further trip within an hour. */
  cooldownMs: number;
  maxCooldownMs: number;
  /** After the pause quotes return `recoverWiden`x wider, decaying linearly to 1x over this long. */
  recoverMs: number;
  recoverWiden: number;
  /** Stop for good (or cool off, see `haltMode`) after this many trips within an hour. */
  haltAfterTripsPerHour: number;
  /** "halt": the engine halts. "cooloff": quotes stay off for `cooloffMs`, the trip history is forgotten, trading resumes. */
  haltMode?: "halt" | "cooloff";
  cooloffMs?: number;
  /** Toxic-flow trip: this many recent fills averaging worse than -toxicMarkoutBps. */
  toxicFills: number;
  toxicMarkoutBps: number;
}

export interface FuseInput {
  /** Fair price, or null when there is no usable book. */
  fair: number | null;
  spreadBps: number | null;
  oracleDevBps: number | null;
}

export type FuseStatus =
  | { state: "ok" }
  | { state: "tripped"; until: number; reason: string; justTripped: boolean }
  | { state: "recovering"; widen: number }
  | { state: "halt"; reason: string };

const HOUR = 3_600_000;

export class VolatilityFuse {
  private samples: { ts: number; fair: number }[] = [];
  private trips: number[] = [];
  private until = 0;
  private recoverUntil = 0;
  private reason = "";
  private haltReason: string | null = null;
  private pendingJustTripped = false;

  constructor(private readonly cfg: FuseConfig) {}

  get tripsInLastHour(): number {
    return this.trips.length;
  }

  /** Time (ms) until which the fuse keeps quotes off; 0 when it is not tripped. */
  get untilMs(): number {
    return this.until;
  }

  /** After a restart: keep quotes off until `until`, as the previous process had decided. Ignored when already past. */
  restoreUntil(until: number, now: number): void {
    if (!(until > now)) return;
    this.until = until;
    this.recoverUntil = until + this.cfg.recoverMs;
    this.reason = "restored after a restart";
    this.pendingJustTripped = false;
  }

  /** Feed one observation and get the current status. */
  observe(now: number, inp: FuseInput): FuseStatus {
    if (!this.cfg.enabled) return { state: "ok" };
    if (this.haltReason) return { state: "halt", reason: this.haltReason };
    this.trips = this.trips.filter((t) => now - t < HOUR);

    if (now < this.until) return this.tripped(false);

    if (inp.fair !== null && inp.fair > 0) {
      this.samples.push({ ts: now, fair: inp.fair });
      const cutoff = now - this.cfg.slowWindowMs;
      while (this.samples.length > 1 && this.samples[0]!.ts < cutoff) this.samples.shift();
    }

    const why = this.check(now, inp);
    if (why) return this.trip(now, why);

    if (now < this.recoverUntil) {
      const left = (this.recoverUntil - now) / this.cfg.recoverMs;
      return { state: "recovering", widen: 1 + (this.cfg.recoverWiden - 1) * left };
    }
    return { state: "ok" };
  }

  /** Trip from outside (e.g. toxic flow detected by the engine). */
  trip(now: number, reason: string): FuseStatus {
    if (!this.cfg.enabled) return { state: "ok" };
    if (this.haltReason) return { state: "halt", reason: this.haltReason };
    this.trips = this.trips.filter((t) => now - t < HOUR);
    this.trips.push(now);
    let cooldown = Math.min(this.cfg.maxCooldownMs, this.cfg.cooldownMs * 2 ** (this.trips.length - 1));
    if (this.trips.length >= this.cfg.haltAfterTripsPerHour) {
      const text = `${this.trips.length} fuse trips within an hour (last: ${reason})`;
      if (this.cfg.haltMode !== "cooloff") {
        this.haltReason = text;
        return { state: "halt", reason: this.haltReason };
      }
      cooldown = this.cfg.cooloffMs ?? 3_600_000;
      this.trips = [];
      reason = `${text}; cooling off ${Math.round(cooldown / 60_000)} min`;
    }
    this.until = now + cooldown;
    this.recoverUntil = this.until + this.cfg.recoverMs;
    this.reason = reason;
    this.samples = []; // the post-move price is the new baseline
    this.pendingJustTripped = true;
    return this.tripped(true);
  }

  private tripped(first: boolean): FuseStatus {
    const justTripped = first || this.pendingJustTripped;
    this.pendingJustTripped = false;
    return { state: "tripped", until: this.until, reason: this.reason, justTripped };
  }

  private check(now: number, inp: FuseInput): string | null {
    const c = this.cfg;
    const fast = this.rangeBps(now, c.fastWindowMs);
    if (fast >= c.fastMoveBps) return `price moved ${fast.toFixed(1)} bps within ${c.fastWindowMs / 1000}s`;
    const slow = this.rangeBps(now, c.slowWindowMs);
    if (slow >= c.slowMoveBps) return `price moved ${slow.toFixed(1)} bps within ${c.slowWindowMs / 1000}s`;
    if (inp.spreadBps !== null && inp.spreadBps >= c.spreadBps) return `book spread ${inp.spreadBps.toFixed(1)} bps`;
    if (inp.oracleDevBps !== null && inp.oracleDevBps >= c.oracleDevBps) return `book/oracle divergence ${inp.oracleDevBps.toFixed(1)} bps`;
    return null;
  }

  /** High-low range of fair over the window, in bps of the low. */
  private rangeBps(now: number, windowMs: number): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]!;
      if (now - s.ts > windowMs) break;
      if (s.fair < lo) lo = s.fair;
      if (s.fair > hi) hi = s.fair;
    }
    return lo > 0 && hi >= lo ? ((hi - lo) / lo) * 1e4 : 0;
  }
}
