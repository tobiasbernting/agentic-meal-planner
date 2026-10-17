import { runWithRunId } from "../logging/run-context.js";
import type { OnProgress } from "./phase.js";
import type { PlanRunDetails } from "./registry.js";
import { trackPlanRun, type TrackPlanRunDeps } from "./track.js";

export type LaunchPlanRunDeps = TrackPlanRunDeps;

/**
 * Registers a Plan Run for the week and starts `pipeline` without awaiting it, tracked by
 * `trackPlanRun` (see there for what a failure leaves stored); it runs under `runId` so shared
 * loggers tag its records. Returns false, starting nothing, when the week already has a run in
 * flight. Anything thrown after the run is tracked (ending it, logging) is logged at error level.
 */
export function launchPlanRun(
  deps: LaunchPlanRunDeps,
  { weekStart, runId }: { weekStart: string; runId: string },
  pipeline: (onProgress: OnProgress) => Promise<PlanRunDetails | void>,
): boolean {
  if (!deps.planRuns.start(weekStart, { runId, startedAt: deps.now() })) return false;
  let pipelineError: unknown;
  const tracked = async (onProgress: OnProgress) => {
    try {
      return await pipeline(onProgress);
    } catch (error) {
      pipelineError = error;
      throw error;
    }
  };
  // Runs synchronously up to the pipeline's first await, so its first Phase is in the registry on return.
  void runWithRunId(runId, () => trackPlanRun(deps, weekStart, tracked, (details) => details ?? {})).catch((error: unknown) => {
    if (error === pipelineError) return; // trackPlanRun has logged it and marked the run failed
    deps.log.child({ component: "plan-run" }).error({ weekStart, err: error instanceof Error ? error.message : String(error) }, "plan run tracking failed");
  });
  return true;
}
