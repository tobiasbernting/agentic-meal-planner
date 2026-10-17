/**
 * Which Plan Runs are in flight, per week, and how the last one ended (spec #61). Lives in
 * the process on the AppContext; nothing is persisted, so a restart forgets it (ADR-0002).
 * At most one Plan Run per week is in flight; the next run of a week replaces its outcome.
 */
import type { LunchChange } from "../lunch/ingest.js";
import type { Phase, PhaseProgress, PlanRunEvent } from "./phase.js";

export interface InFlightPlanRun {
  runId: string;
  startedAt: Date;
  /** The Phase reported last; undefined until the pipeline reports its first one. */
  phase?: Phase;
  /** Progress within `phase` (Ingredient resolution only). */
  progress?: PhaseProgress;
}

/** How a Plan Run ended. */
export type PlanRunOutcome =
  | { kind: "finished"; runId: string; at: Date; lunchChanged: LunchChange[] }
  | { kind: "failed"; runId: string; at: Date; message: string };

export type PlanRunState = { inFlight: InFlightPlanRun } | { outcome: PlanRunOutcome };

export interface PlanRunRegistry {
  /** Registers a Plan Run for the week; false (and nothing changes) when one is already in flight. */
  start(weekStart: string, run: { runId: string; startedAt: Date }): boolean;
  /** Records a Phase transition or progress for the week's in-flight run. */
  report(weekStart: string, event: PlanRunEvent): void;
  /** Ends the week's in-flight run as finished. */
  finish(weekStart: string, at: Date, details?: { lunchChanged?: LunchChange[] }): void;
  /** Ends the week's in-flight run as failed with the error message. */
  fail(weekStart: string, at: Date, message: string): void;
  /** The week's in-flight run, else its last outcome, else undefined. */
  get(weekStart: string): PlanRunState | undefined;
}

export function createPlanRunRegistry(): PlanRunRegistry {
  const weeks = new Map<string, PlanRunState>();
  const inFlight = (weekStart: string) => {
    const state = weeks.get(weekStart);
    return state && "inFlight" in state ? state.inFlight : undefined;
  };
  return {
    start(weekStart, { runId, startedAt }) {
      if (inFlight(weekStart)) return false;
      weeks.set(weekStart, { inFlight: { runId, startedAt } });
      return true;
    },
    report(weekStart, { phase, progress }) {
      const run = inFlight(weekStart);
      if (!run) return;
      run.phase = phase;
      if (progress) run.progress = progress;
      else delete run.progress;
    },
    finish(weekStart, at, details = {}) {
      const run = inFlight(weekStart);
      if (run) weeks.set(weekStart, { outcome: { kind: "finished", runId: run.runId, at, lunchChanged: details.lunchChanged ?? [] } });
    },
    fail(weekStart, at, message) {
      const run = inFlight(weekStart);
      if (run) weeks.set(weekStart, { outcome: { kind: "failed", runId: run.runId, at, message } });
    },
    get(weekStart) {
      return weeks.get(weekStart);
    },
  };
}
