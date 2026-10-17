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
  SEED_DISHES,
  type Dish as LlmDish,
  type DishSuggestion,
  type LlmAgent,
  type SelectDishesInput,
  type SelectedDish,
} from "../llm/index.js";
import type { LunchEntry } from "../types.js";
import { createSeedPicker, resolveSuggestion } from "./suggestions.js";
import { quickDayLimitFor, type PlannerSettings } from "./settings.js";
import { weekDates, weekdayOf } from "../week.js";

export const NO_ELIGIBLE_DISH_RATIONALE = "no eligible dish, pick one";
/** Rationale for a date filled from the built-in seed list (no agent, or the agent's suggestion was dropped). */
export const SEED_FALLBACK_RATIONALE = "no eligible Favorite Dish; picked from the seed list";

export interface RecentlyPlanned {
  dishId: string;
  name: string;
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
  /** A reused Dish; `null` when the date takes a new Suggested Dish or stays empty. */
  dishId: number | null;
  /** A brand-new Suggested Dish to create. At most one of `dishId`/`suggestion` is non-null; both null = empty. */
  suggestion: DishSuggestion | null;
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

/** The agent's picks, and whether they came from NoAgent (configured, or as the fallback after an agent failure). */
async function select(
  llm: LlmAgent,
  request: SelectDishesInput,
  degradedReasons: string[],
): Promise<{ picks: SelectedDish[]; fromNoAgent: boolean }> {
  if (llm instanceof NoAgent) degradedReasons.push(NO_AGENT_REASON);
  const result = await llm.selectDishes(request);
  if (result.ok) return { picks: result.value, fromNoAgent: llm instanceof NoAgent };
  degradedReasons.push(result.reason);
  const fallback = await new NoAgent().selectDishes(request);
  return { picks: fallback.ok ? fallback.value : [], fromNoAgent: true };
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
    suggestionStyle: input.settings.suggestionStyle,
    seedDishes: SEED_DISHES,
  };
  const degradedReasons: string[] = [];
  const { picks, fromNoAgent } = await select(input.llm, request, degradedReasons);
  const pickByDate = new Map(picks.map((p) => [p.date, p]));
  const filterOptions = { categoryCollisionEnabled: input.settings.categoryCollisionEnabled };
  const pickSeed = createSeedPicker(
    SEED_DISHES,
    input.dishes,
    filterOptions,
    input.recentlyPlanned.map((r) => r.name),
  );

  const dinners = days.map((day, i): PlannedDinnerDraft => {
    const eligible = candidates[i]?.eligible ?? [];
    const base = {
      date: day.date,
      isQuickDay: day.quickDayLimitMinutes !== null,
      lunchThatDay: day.lunch.length > 0 ? day.lunch.map((l) => l.rawText).join("; ") : null,
    };
    const pick = pickByDate.get(day.date);

    if (eligible.length === 0) {
      if (pick !== undefined && !fromNoAgent) {
        const outcome =
          "suggestion" in pick
            ? resolveSuggestion(pick.suggestion, day, input.dishes, filterOptions)
            : ({ kind: "dropped", why: `agent picked dish ${pick.dishId} instead of suggesting one` } as const);
        if (outcome.kind === "reuse") return { ...base, dishId: outcome.dishId, suggestion: null, rationale: pick.rationale };
        if (outcome.kind === "new") return { ...base, dishId: null, suggestion: outcome.suggestion, rationale: pick.rationale };
        const name = "suggestion" in pick ? String((pick.suggestion as { name?: unknown } | null)?.name ?? "") : "";
        degradedReasons.push(`${day.date}: suggestion "${name}" dropped: ${outcome.why}`);
      }
      const seed = pickSeed(day);
      if (seed === undefined) return { ...base, dishId: null, suggestion: null, rationale: NO_ELIGIBLE_DISH_RATIONALE };
      degradedReasons.push(`${day.date}: seed fallback used`);
      return seed.kind === "reuse"
        ? { ...base, dishId: seed.dishId, suggestion: null, rationale: SEED_FALLBACK_RATIONALE }
        : { ...base, dishId: null, suggestion: seed.suggestion, rationale: SEED_FALLBACK_RATIONALE };
    }

    if (pick === undefined) return { ...base, dishId: null, suggestion: null, rationale: NO_ELIGIBLE_DISH_RATIONALE };
    const pickedId = "dishId" in pick ? pick.dishId : undefined;
    const chosen = eligible.find((d) => String(d.id) === pickedId);
    if (chosen === undefined) {
      const reason = `${day.date}: agent picked dish ${pickedId ?? "(suggestion)"}, which is not eligible that day; dropped`;
      degradedReasons.push(reason);
      return {
        ...base,
        dishId: null,
        suggestion: null,
        rationale: `agent pick dropped (not eligible); ${NO_ELIGIBLE_DISH_RATIONALE}`,
      };
    }
    return { ...base, dishId: chosen.id, suggestion: null, rationale: pick.rationale || NO_ELIGIBLE_DISH_RATIONALE };
  });

  return { weekStart: input.weekStart, dinners, degradedReasons };
}
