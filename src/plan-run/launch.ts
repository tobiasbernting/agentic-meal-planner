import type { LunchChange } from "../lunch/ingest.js";
import { runWithRunId } from "../logging/run-context.js";
import type { Logger } from "../logging/logger.js";
import type { OnProgress } from "./phase.js";
import { logPlanRunProgress } from "./progress-log.js";
import type { PlanRunRegistry } from "./registry.js";

export interface LaunchPlanRunDeps {
  planRuns: PlanRunRegistry;
  now: () => Date;
  /** The run logger (already bound to the run's component); Phase records go to its `plan-run` child. */
  log: Logger;
}

/** What a finished pipeline hands back for the outcome. */
export interface PlanRunDetails {
  lunchChanged?: LunchChange[];
}

/**
 * Registers a Plan Run for the week and starts `pipeline` without awaiting it. Every Phase
 * report updates the registry and is logged; the pipeline runs under `runId` so shared loggers
 * tag its records. Returns false, starting nothing, when the week already has a run in flight.
 * A throw from the pipeline is logged at error level and ends the run as failed.
 */
export function launchPlanRun(
  deps: LaunchPlanRunDeps,
  { weekStart, runId }: { weekStart: string; runId: string },
  pipeline: (onProgress: OnProgress) => Promise<PlanRunDetails | void>,
): boolean {
  if (!deps.planRuns.start(weekStart, { runId, startedAt: deps.now() })) return false;
  const logProgress = logPlanRunProgress(deps.log, weekStart);
  const onProgress: OnProgress = (event) => {
    deps.planRuns.report(weekStart, event);
    logProgress(event);
  };
  // Runs synchronously up to the pipeline's first await, so its first Phase is in the registry on return.
  void runWithRunId(runId, () => new Promise<PlanRunDetails | void>((resolve) => resolve(pipeline(onProgress)))).then(
    (details) => deps.planRuns.finish(weekStart, deps.now(), details ?? {}),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.child({ component: "plan-run" }).error({ weekStart, err: message }, "plan run failed");
      deps.planRuns.fail(weekStart, deps.now(), message);
    },
  );
  return true;
}
