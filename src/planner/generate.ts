/**
 * Composes the planner seam with the database: loads a week's inputs, runs `planWeek`, and
 * stores the Weekly Plan (FR-9). It reads already-stored Lunch Entries but neither ingests
 * lunch menus nor pushes shopping sinks; those compositions belong to #33/#34.
 */
import { silentLogger, type Logger } from "../logging/logger.js";
import type { OnProgress } from "../plan-run/phase.js";
import type Database from "better-sqlite3";
import { isMainCategory } from "../dishes/categories.js";
import { createDish, listDishes } from "../dishes/repo.js";
import type { LlmAgent } from "../llm/index.js";
import { listLunchEntries } from "../lunch/repo.js";
import { listActiveSchools } from "../schools/repo.js";
import { normaliseName } from "../text.js";
import type { LunchEntry } from "../types.js";
import { planWeek, type PlannedDinnerDraft, type PlanWeekResult } from "./plan-week.js";
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
  /** Plan Run progress reports (Phase transitions); omitted outside a Plan Run. */
  onProgress?: OnProgress;
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
  deps.onProgress?.({ phase: "dish-selection" });

  const settings = readPlannerSettings(db);
  const plan = await planWeek({
    weekStart,
    // All Dishes: the engine keeps only Favorite Dishes eligible; suggestions reuse the rest by name.
    dishes: listDishes(db),
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
  const planId = db.transaction(() => savePlan(db, storeSuggestions(db, plan), deps.now()))();
  return { planId, degradedReasons: plan.degradedReasons };
}

/**
 * Creates one Suggested Dish per distinct suggestion name (not in rotation, no URL, no
 * Ingredients) and points the drafts at it, so the stored plan only holds Dish ids.
 */
function storeSuggestions(db: Database.Database, plan: PlanWeekResult): PlanWeekResult {
  const created = new Map<string, number>();
  const dinners = plan.dinners.map((draft): PlannedDinnerDraft => {
    const { suggestion } = draft;
    if (suggestion === null) return draft;
    const key = normaliseName(suggestion.name);
    let dishId = created.get(key);
    if (dishId === undefined) {
      dishId = createDish(db, {
        name: suggestion.name,
        mainCategory: isMainCategory(suggestion.mainCategory) ? suggestion.mainCategory : null,
        prepTimeMinutes: suggestion.prepTimeMinutes ?? null,
        inRotation: false,
        suggested: true,
      });
      created.set(key, dishId);
    }
    return { ...draft, dishId, suggestion: null };
  });
  return { ...plan, dinners };
}
