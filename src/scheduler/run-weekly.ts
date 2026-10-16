/**
 * The scheduled weekly run (FR-9): refresh the coming week's lunch menus, then generate its
 * Weekly Plan. A confirmed plan is never overwritten by this run (FR-9a); `generatePlan`
 * reports `{ skipped: "confirmed" }` and the stored plan stays as it is.
 */
import type Database from "better-sqlite3";
import type { LlmAgent } from "../llm/index.js";
import { ingestWeek, type IngestResult } from "../lunch/ingest.js";
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
   * (#31) and sink push (#32) hook in here without touching this file.
   */
  afterPlan?: (planId: number) => Promise<void>;
}

export interface WeeklyRunResult {
  /** Monday of the planned (coming) week. */
  weekStart: string;
  ingest: IngestResult;
  plan: GeneratePlanResult;
}

export async function runWeeklyPlanning(deps: WeeklyRunDeps): Promise<WeeklyRunResult> {
  const weekStart = comingWeekStart(deps.now(), readTimezone(deps.db));
  // FR-9a: a confirmed week is left alone entirely, so do not even re-fetch its menus.
  if (getPlanForWeek(deps.db, weekStart)?.status === "confirmed") {
    return { weekStart, ingest: { results: [], changed: [] }, plan: { skipped: "confirmed" } };
  }
  const ingest = await ingestWeek(deps, weekStart);
  const plan = await generatePlan({ db: deps.db, llm: deps.llm, now: () => deps.now().toISOString() }, weekStart, {
    replace: false,
  });
  if ("planId" in plan && deps.afterPlan) await deps.afterPlan(plan.planId);
  return { weekStart, ingest, plan };
}
