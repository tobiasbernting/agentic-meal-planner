/**
 * Composes the planner seam with the database: loads a week's inputs, runs `planWeek`, and
 * stores the Weekly Plan (FR-9). It reads already-stored Lunch Entries but neither ingests
 * lunch menus nor pushes shopping sinks; those compositions belong to #33/#34.
 */
import { silentLogger, type Logger } from "../logging/logger.js";
import type Database from "better-sqlite3";
import { listDishes } from "../dishes/repo.js";
import type { LlmAgent } from "../llm/index.js";
import { listLunchEntries } from "../lunch/repo.js";
import { listActiveSchools } from "../schools/repo.js";
import type { LunchEntry } from "../types.js";
import { planWeek } from "./plan-week.js";
import { getPlanForWeek, listRecentlyPlanned, savePlan } from "./repo.js";
import { readPlannerSettings } from "./settings.js";
import { weekDates } from "../week.js";

export type LunchLoader = (db: Database.Database, weekStart: string) => Record<string, LunchEntry[]>;

export interface GeneratePlanDeps {
  db: Database.Database;
  llm: LlmAgent;
  /** Clock port: ISO timestamp for `generated_at`. */
  now: () => string;
  /** Loads the week's Lunch Entries keyed by date. Defaults to `loadStoredLunch` (the lunch repo). */
  loadLunch?: LunchLoader;
  /** Run logger (bound to `runId`); defaults to `silentLogger`. */
  log?: Logger;
}

/**
 * The week's stored Lunch Entries of every active School, keyed by date: one entry per School
 * per date (its `rawText` may hold several lines). Paused Schools do not constrain dinner.
 */
export const loadStoredLunch: LunchLoader = (db, weekStart) => {
  const dates = weekDates(weekStart);
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const byDate: Record<string, LunchEntry[]> = {};
  for (const school of listActiveSchools(db)) {
    for (const entry of listLunchEntries(db, school.id, from, to)) {
      const lunch: LunchEntry = { date: entry.date, rawText: entry.rawText };
      if (entry.normalizedName !== null) lunch.normalizedName = entry.normalizedName;
      if (entry.mainCategory !== null) lunch.mainCategory = entry.mainCategory;
      (byDate[entry.date] ??= []).push(lunch);
    }
  }
  return byDate;
};

export interface GeneratePlanOptions {
  /** FR-9a: a confirmed plan is only replaced on an explicit manual regenerate. */
  replace?: boolean;
}

export type GeneratePlanResult = { planId: number; degradedReasons: string[] } | { skipped: "confirmed" };

export async function generatePlan(
  deps: GeneratePlanDeps,
  weekStart: string,
  options: GeneratePlanOptions = {},
): Promise<GeneratePlanResult> {
  const { db } = deps;
  const existing = getPlanForWeek(db, weekStart);
  if (existing?.status === "confirmed" && !options.replace) return { skipped: "confirmed" };

  const settings = readPlannerSettings(db);
  const plan = await planWeek({
    weekStart,
    dishes: listDishes(db).filter((d) => d.inRotation),
    lunchByDate: (deps.loadLunch ?? loadStoredLunch)(db, weekStart),
    settings,
    recentlyPlanned: listRecentlyPlanned(db, weekStart, settings.varietyWindowWeeks),
    llm: deps.llm,
  });
  if (plan.degradedReasons.length > 0) {
    (deps.log ?? silentLogger).child({ component: "planner" }).warn(
      { weekStart, degradedReasons: plan.degradedReasons },
      "plan degraded: deterministic selection used where the agent could not",
    );
  }
  const planId = savePlan(db, plan, deps.now());
  return { planId, degradedReasons: plan.degradedReasons };
}
