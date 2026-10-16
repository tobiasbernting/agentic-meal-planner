/**
 * Composes the planner seam with the database: loads a week's inputs, runs `planWeek`, and
 * stores the Weekly Plan (FR-9). It neither ingests lunch menus nor pushes shopping sinks;
 * those compositions belong to the regenerate/scheduler tickets (#33, #34).
 */
import type Database from "better-sqlite3";
import { listDishes } from "../dishes/repo.js";
import type { LlmAgent } from "../llm/index.js";
import type { LunchEntry } from "../types.js";
import { planWeek } from "./plan-week.js";
import { getPlanForWeek, listRecentlyPlanned, savePlan } from "./repo.js";
import { readPlannerSettings } from "./settings.js";

export type LunchLoader = (db: Database.Database, weekStart: string) => Record<string, LunchEntry[]>;

export interface GeneratePlanDeps {
  db: Database.Database;
  llm: LlmAgent;
  /** Clock port: ISO timestamp for `generated_at`. */
  now: () => string;
  /**
   * Loads the week's Lunch Entries keyed by date. Defaults to none: the lunch repo (ticket
   * #23) had not landed when this was written, so the caller wires it (see #33/#34).
   */
  loadLunch?: LunchLoader;
}

export interface GeneratePlanOptions {
  /** FR-9a: a confirmed plan is only replaced on an explicit manual regenerate. */
  replace?: boolean;
}

export type GeneratePlanResult = { planId: number; degradedReasons: string[] } | { skipped: "confirmed" };

const noLunch: LunchLoader = () => ({});

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
    lunchByDate: (deps.loadLunch ?? noLunch)(db, weekStart),
    settings,
    recentlyPlanned: listRecentlyPlanned(db, weekStart, settings.varietyWindowWeeks),
    llm: deps.llm,
  });
  const planId = savePlan(db, plan, deps.now());
  return { planId, degradedReasons: plan.degradedReasons };
}
