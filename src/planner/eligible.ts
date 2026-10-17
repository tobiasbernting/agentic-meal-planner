/**
 * Per-date eligibility (spec #71, Swap): the deterministic engine's hard rules applied to one
 * dinner date with the stored lunch, planner settings and the week's other Planned Dinners (Once a
 * Week), so a hand pick can never break a rule.
 */
import type Database from "better-sqlite3";
import { listDishes, type Dish } from "../dishes/repo.js";
import { filterEligibleDishes, type PlannedElsewhere } from "../engine/filter.js";
import { mondayOf, weekdayOf } from "../week.js";
import { loadStoredLunch } from "./generate.js";
import { getPlanForWeek } from "./repo.js";
import { quickDayLimitFor, readPlannerSettings } from "./settings.js";

/** The Dishes that pass every hard rule on `date`, in name order. */
export function eligibleDishesOn(db: Database.Database, date: string): Dish[] {
  const settings = readPlannerSettings(db);
  const weekStart = mondayOf(date);
  const weekday = weekdayOf(date);
  const dishes = listDishes(db);
  const plannedElsewhere = (getPlanForWeek(db, weekStart)?.dinners ?? []).flatMap((d): PlannedElsewhere[] => {
    const dish = d.date === date || d.dishId === null ? undefined : dishes.find((x) => x.id === d.dishId);
    return dish ? [{ date: d.date, dishId: dish.id, name: dish.name }] : [];
  });
  const day = {
    date,
    weekday,
    quickDayLimitMinutes: quickDayLimitFor(settings, weekStart, weekday),
    lunch: loadStoredLunch(db, weekStart)[date] ?? [],
    plannedElsewhere,
  };
  return filterEligibleDishes(dishes, day, { categoryCollisionEnabled: settings.categoryCollisionEnabled }).eligible;
}
