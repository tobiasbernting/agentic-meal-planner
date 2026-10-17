import type { Logger } from "../logging/logger.js";
import type { OnProgress } from "./phase.js";
import { logPlanRunProgress } from "./progress-log.js";
import type { PlanRunDetails, PlanRunRegistry } from "./registry.js";

export interface TrackPlanRunDeps {
  planRuns: PlanRunRegistry;
  now: () => Date;
  /** The run logger; Phase records and the failure record go to its `plan-run` child. */
  log: Logger;
}

/**
 * Runs `pipeline` as the week's Plan Run, which the caller has already registered with
 * `planRuns.start`. Every Phase report updates the registry and is logged. When the pipeline
 * resolves, the run ends as finished with `detailsOf(result)`; when it throws, the run ends as
 * failed, the error is logged at error level and rethrown.
 *
 * Failure leaves stored rows as they were before the throw, nothing more: the pipeline saves the
 * Weekly Plan right after Dish selection (so the dinners show mid-run), so a later throw keeps
 * the new plan and only the steps after it are missing.
 */
export async function trackPlanRun<T>(
  deps: TrackPlanRunDeps,
  weekStart: string,
  pipeline: (onProgress: OnProgress) => Promise<T>,
  detailsOf: (result: T) => PlanRunDetails = () => ({}),
): Promise<T> {
  const logProgress = logPlanRunProgress(deps.log, weekStart);
  const onProgress: OnProgress = (event) => {
    deps.planRuns.report(weekStart, event);
    logProgress(event);
  };
  let result: T;
  try {
    result = await pipeline(onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.planRuns.fail(weekStart, deps.now(), message);
    deps.log.child({ component: "plan-run" }).error({ weekStart, err: message }, "plan run failed");
    throw error;
  }
  deps.planRuns.finish(weekStart, deps.now(), detailsOf(result));
  return result;
}
