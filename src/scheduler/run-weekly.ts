/**
 * The scheduled weekly run (FR-9): refresh the coming week's lunch menus, then generate its
 * Weekly Plan. A confirmed plan is never overwritten by this run (FR-9a); `generatePlan`
 * reports `{ skipped: "confirmed" }` and the stored plan stays as it is.
 */
import type Database from "better-sqlite3";
import type { LlmAgent } from "../llm/index.js";
import { silentLogger, type Logger } from "../logging/logger.js";
import { currentRunId } from "../logging/run-context.js";
import type { OnProgress } from "../plan-run/phase.js";
import { logPlanRunProgress } from "../plan-run/progress-log.js";
import type { PlanRunRegistry } from "../plan-run/registry.js";
import { ingestWeek, type IngestResult } from "../lunch/ingest.js";
import { logPlanSummary } from "../planner/summary.js";
import { readTimezone } from "../planner/settings.js";
import { getPlanForWeek } from "../planner/repo.js";
import { generatePlan, type GeneratePlanResult } from "../planner/generate.js";
import type { FetchPage } from "../plugins/schools/index.js";
import { comingWeekStart } from "../week.js";

export interface WeeklyRunDeps {
  db: Database.Database;
  llm: LlmAgent;
  fetchPage: FetchPage;
  /** Clock port; the run plans the week after the one containing `now()` (local date). */
  now: () => Date;
  /**
   * Chained after a plan is stored (not when the week was skipped). The Shopping List build
   * (#31) and sink push (#32) hook in here without touching this file. Receives the run logger
   * and the Plan Run progress callback (it reports the shopping Phases), and may return how
   * many sinks accepted the list (for the plan summary).
   */
  afterPlan?: (planId: number, log: Logger | undefined, onProgress: OnProgress) => Promise<number | void>;
  /** Run logger bound to `runId: cron-<ISO>`; the scheduler sets it per tick. */
  log?: Logger;
  /**
   * The Plan Run registry (spec #61). When set, the run registers for the coming week and
   * reports its Phases there, so the Plan page banner shows it; a week already in flight is skipped.
   */
  planRuns?: PlanRunRegistry;
}

export interface WeeklyRunResult {
  /** Monday of the planned (coming) week. */
  weekStart: string;
  ingest: IngestResult;
  /** `{ skipped: "in-flight" }` when another Plan Run of the week was in flight; nothing ran. */
  plan: GeneratePlanResult | { skipped: "in-flight" };
}

export async function runWeeklyPlanning(deps: WeeklyRunDeps): Promise<WeeklyRunResult> {
  const weekStart = comingWeekStart(deps.now(), readTimezone(deps.db));
  // FR-9a: a confirmed week is left alone entirely, so do not even re-fetch its menus.
  if (getPlanForWeek(deps.db, weekStart)?.status === "confirmed") {
    return { weekStart, ingest: { results: [], changed: [] }, plan: { skipped: "confirmed" } };
  }
  if (deps.planRuns && !deps.planRuns.start(weekStart, { runId: currentRunId() ?? "cron", startedAt: deps.now() })) {
    (deps.log ?? silentLogger).child({ component: "plan-run" }).info({ weekStart, reason: "in-flight" }, "weekly run skipped: Plan Run already in flight");
    return { weekStart, ingest: { results: [], changed: [] }, plan: { skipped: "in-flight" } };
  }
  const onProgress = logPlanRunProgress(deps.log ?? silentLogger, weekStart);
  const ingest = await ingestWeek({ ...deps, onProgress }, weekStart);
  const plan = await generatePlan(
    { db: deps.db, llm: deps.llm, now: () => deps.now().toISOString(), ...(deps.log ? { log: deps.log } : {}), onProgress },
    weekStart,
    { replace: false },
  );
  if ("planId" in plan) {
    const sinksPushed = deps.afterPlan ? await deps.afterPlan(plan.planId, deps.log, onProgress) : undefined;
    logPlanSummary(deps.log, deps.db, plan.planId, plan.degradedReasons, sinksPushed ?? 0);
  }
  return { weekStart, ingest, plan };
}
