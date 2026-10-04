/**
 * Staged size ramp: start small, earn the right to trade bigger.
 *
 * The configured `maxPositionUsd` / `levelSizeUsd` are the FINAL sizes. The bot starts at the
 * first stage's fraction and moves up one stage only after a full stage period with enough fills,
 * no fuse trips and equity not meaningfully down. A stage that loses more than its limit demotes
 * the bot one stage (or halts it at the first stage).
 */

export interface RampConfig {
  enabled: boolean;
  /** Size multipliers, ascending. The last should normally be 1. */
  stages: number[];
  /** Minimum time at a stage before it can advance. */
  minStageMs: number;
  /** Minimum fills during the stage before it can advance. */
  minStageFills: number;
  /** Demote/halt when equity falls this far (% of stage-start equity) during the stage. */
  maxStageLossPct: number;
  /** Fuse trips tolerated during a stage before it may advance. */
  maxStageTrips: number;
}

export interface RampState {
  stage: number;
  stageStartMs: number;
  stageStartEquity: number;
  stageStartFills: number;
  stageStartTrips: number;
}

export type RampEvent =
  | { kind: "none" }
  | { kind: "advanced"; from: number; to: number }
  | { kind: "demoted"; from: number; to: number; lossPct: number }
  | { kind: "exhausted"; lossPct: number };

export class RampController {
  private s: RampState | null = null;

  constructor(private readonly cfg: RampConfig) {}

  /** Size multiplier for the current stage (1 when disabled). */
  get mult(): number {
    if (!this.cfg.enabled || this.cfg.stages.length === 0) return 1;
    const i = Math.min(this.s?.stage ?? 0, this.cfg.stages.length - 1);
    return this.cfg.stages[i]!;
  }

  get stage(): number {
    return this.s?.stage ?? 0;
  }

  snapshot(): RampState | null {
    return this.s ? { ...this.s } : null;
  }

  /** Restore only the stage after a restart; the evidence for the next move starts fresh. */
  restoreStage(stage: number): void {
    if (!this.cfg.enabled) return;
    const i = Math.max(0, Math.min(Math.floor(stage), this.cfg.stages.length - 1));
    this.s = { stage: i, stageStartMs: 0, stageStartEquity: NaN, stageStartFills: 0, stageStartTrips: 0 };
  }

  update(now: number, equity: number | null, counters: { fills: number; trips: number }): RampEvent {
    if (!this.cfg.enabled || equity === null || !Number.isFinite(equity)) return { kind: "none" };
    if (!this.s || !Number.isFinite(this.s.stageStartEquity)) {
      const stage = this.s?.stage ?? 0;
      this.s = { stage, stageStartMs: now, stageStartEquity: equity, stageStartFills: counters.fills, stageStartTrips: counters.trips };
      return { kind: "none" };
    }
    const s = this.s;
    const lossPct = s.stageStartEquity > 0 ? ((s.stageStartEquity - equity) / s.stageStartEquity) * 100 : 0;

    if (lossPct >= this.cfg.maxStageLossPct) {
      if (s.stage === 0) return { kind: "exhausted", lossPct };
      const to = s.stage - 1;
      this.s = { stage: to, stageStartMs: now, stageStartEquity: equity, stageStartFills: counters.fills, stageStartTrips: counters.trips };
      return { kind: "demoted", from: s.stage, to, lossPct };
    }

    const last = this.cfg.stages.length - 1;
    const aged = now - s.stageStartMs >= this.cfg.minStageMs;
    const active = counters.fills - s.stageStartFills >= this.cfg.minStageFills;
    const calm = counters.trips - s.stageStartTrips <= this.cfg.maxStageTrips;
    const notBleeding = lossPct < this.cfg.maxStageLossPct / 2;
    if (s.stage < last && aged && active && calm && notBleeding) {
      const to = s.stage + 1;
      this.s = { stage: to, stageStartMs: now, stageStartEquity: equity, stageStartFills: counters.fills, stageStartTrips: counters.trips };
      return { kind: "advanced", from: s.stage, to };
    }
    return { kind: "none" };
  }
}
