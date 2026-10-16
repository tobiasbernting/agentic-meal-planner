/**
 * The one planner seam (spec #17 Testing Decisions): takes a week's inputs and returns the
 * Weekly Plan. Pure with respect to I/O: no DB, no clock, no network; the LlmAgent port is
 * the only collaborator. Stage one filters by the hard rules (ADR-0001, FR-6), stage two
 * selects through `LlmAgent.selectDishes` (FR-7) and every Planned Dinner carries a
 * rationale (FR-8). With no agent, selection degrades to round-robin (FR-16).
 */
import type { Dish, Weekday } from "../dishes/repo.js";
import { buildCandidateSets, type DayInput } from "../engine/filter.js";
import {
  NO_AGENT_REASON,
  NoAgent,
  type Dish as LlmDish,
  type LlmAgent,
  type SelectDishesInput,
  type SelectedDish,
} from "../llm/index.js";
import type { LunchEntry } from "../types.js";
import { quickDayLimitFor, type PlannerSettings } from "./settings.js";
import { weekDates, weekdayOf } from "../week.js";

export const NO_ELIGIBLE_DISH_RATIONALE = "no eligible dish, pick one";

export interface RecentlyPlanned {
  dishId: string;
  lastDate: string;
}

export interface PlanWeekInput {
  /** Monday, `YYYY-MM-DD`. */
  weekStart: string;
  /** Favorite Dishes (and any others; the engine excludes out-of-rotation Dishes itself). */
  dishes: Dish[];
  /** Lunch Entries across all active Schools, keyed by date. */
  lunchByDate: Record<string, LunchEntry[]>;
  settings: PlannerSettings;
  /** Variety Preference input: Dishes planned within the variety window. */
  recentlyPlanned: RecentlyPlanned[];
  llm: LlmAgent;
}

export interface PlannedDinnerDraft {
  date: string;
  /** `null` when no Dish was eligible or the pick was rejected: stored empty, never forced. */
  dishId: number | null;
  isQuickDay: boolean;
  /** The day's lunch texts joined, for the plan view; `null` when no Lunch Entry is known. */
  lunchThatDay: string | null;
  rationale: string;
}

export interface PlanWeekResult {
  weekStart: string;
  dinners: PlannedDinnerDraft[];
  /** What the planner could not do; empty for a fully agent-selected plan. */
  degradedReasons: string[];
}

/** What the agent sees per candidate: the port's shape plus Preferred Days (soft preference, FR-7). */
export interface CandidateDish extends LlmDish {
  preferredDays: Weekday[];
}

function toCandidate(dish: Dish): CandidateDish {
  return {
    id: dish.id,
    name: dish.name,
    mainCategory: dish.mainCategory ?? undefined,
    prepTimeMinutes: dish.prepTimeMinutes ?? undefined,
    preferredDays: dish.preferredDays,
  };
}

function toDayInputs(input: PlanWeekInput): DayInput[] {
  return weekDates(input.weekStart).map((date) => {
    const weekday = weekdayOf(date);
    return {
      date,
      weekday,
      quickDayLimitMinutes: quickDayLimitFor(input.settings, input.weekStart, weekday),
      lunch: input.lunchByDate[date] ?? [],
    };
  });
}

async function select(
  llm: LlmAgent,
  request: SelectDishesInput,
  degradedReasons: string[],
): Promise<SelectedDish[]> {
  if (llm instanceof NoAgent) degradedReasons.push(NO_AGENT_REASON);
  const result = await llm.selectDishes(request);
  if (result.ok) return result.value;
  degradedReasons.push(result.reason);
  const fallback = await new NoAgent().selectDishes(request);
  return fallback.ok ? fallback.value : [];
}

export async function planWeek(input: PlanWeekInput): Promise<PlanWeekResult> {
  const days = toDayInputs(input);
  const candidates = buildCandidateSets(input.dishes, days, {
    categoryCollisionEnabled: input.settings.categoryCollisionEnabled,
  });
  const request: SelectDishesInput = {
    days: days.map((d) => ({ date: d.date, isQuickDay: d.quickDayLimitMinutes !== null, lunch: d.lunch })),
    candidates: candidates.map((c) => c.eligible.map(toCandidate)),
    recentlyPlanned: input.recentlyPlanned,
  };
  const degradedReasons: string[] = [];
  const picks = await select(input.llm, request, degradedReasons);
  const pickByDate = new Map(picks.map((p) => [p.date, p]));

  const dinners = days.map((day, i): PlannedDinnerDraft => {
    const eligible = candidates[i]?.eligible ?? [];
    const base = {
      date: day.date,
      isQuickDay: day.quickDayLimitMinutes !== null,
      lunchThatDay: day.lunch.length > 0 ? day.lunch.map((l) => l.rawText).join("; ") : null,
    };
    if (eligible.length === 0) return { ...base, dishId: null, rationale: NO_ELIGIBLE_DISH_RATIONALE };
    const pick = pickByDate.get(day.date);
    if (pick === undefined) return { ...base, dishId: null, rationale: NO_ELIGIBLE_DISH_RATIONALE };
    const chosen = eligible.find((d) => String(d.id) === pick.dishId);
    if (chosen === undefined) {
      const reason = `${day.date}: agent picked dish ${pick.dishId}, which is not eligible that day; dropped`;
      degradedReasons.push(reason);
      return { ...base, dishId: null, rationale: `agent pick dropped (not eligible); ${NO_ELIGIBLE_DISH_RATIONALE}` };
    }
    return { ...base, dishId: chosen.id, rationale: pick.rationale || NO_ELIGIBLE_DISH_RATIONALE };
  });

  return { weekStart: input.weekStart, dinners, degradedReasons };
}
