/**
 * Per-date eligibility (spec #71, Swap): the deterministic engine's hard rules applied to one
 * dinner date with the stored lunch and planner settings, so a hand pick can never break a rule.
 */
import type Database from "better-sqlite3";
import { listDishes, type Dish } from "../dishes/repo.js";
import { filterEligibleDishes } from "../engine/filter.js";
import { mondayOf, weekdayOf } from "../week.js";
import { loadStoredLunch } from "./generate.js";
import { quickDayLimitFor, readPlannerSettings } from "./settings.js";

/** The Dishes that pass every hard rule on `date`, in name order. */
export function eligibleDishesOn(db: Database.Database, date: string): Dish[] {
  const settings = readPlannerSettings(db);
  const weekStart = mondayOf(date);
  const weekday = weekdayOf(date);
  const day = {
    date,
    weekday,
    quickDayLimitMinutes: quickDayLimitFor(settings, weekStart, weekday),
    lunch: loadStoredLunch(db, weekStart)[date] ?? [],
  };
  return filterEligibleDishes(listDishes(db), day, { categoryCollisionEnabled: settings.categoryCollisionEnabled }).eligible;
}
