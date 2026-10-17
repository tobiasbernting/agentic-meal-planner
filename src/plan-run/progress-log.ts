import type { Logger } from "../logging/logger.js";
import type { OnProgress } from "./phase.js";

/**
 * A progress callback that writes one info record per report, `component: "plan-run"`, with
 * the week and the Phase (plus done/total/dish for progress). Pass a run logger so the records
 * carry the request's or cron tick's `runId`.
 */
export function logPlanRunProgress(log: Logger, weekStart: string): OnProgress {
  const planRun = log.child({ component: "plan-run" });
  return ({ phase, progress }) => {
    if (progress) planRun.info({ weekStart, phase, ...progress }, "phase progress");
    else planRun.info({ weekStart, phase }, "phase");
  };
}
