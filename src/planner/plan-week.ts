/**
 * The one planner seam (spec #17 Testing Decisions): takes a week's inputs and returns the
 * Weekly Plan. Pure with respect to I/O: no DB, no clock, no network; the LlmAgent port is
 * the only collaborator. Stage one filters by the hard rules (ADR-0001, FR-6), stage two
 * selects through `LlmAgent.selectDishes` (FR-7) and every Planned Dinner carries a
 * rationale (FR-8). With no agent, selection degrades to round-robin (FR-16).
 */
import type { Dish, Weekday } from "../dishes/repo.js";
import { buildCandidateSets, exclusionParams, exclusionRule, plannedElsewhereOf, type DayInput, type ExclusionRule, type PlannedElsewhere } from "../engine/filter.js";
import {
  NO_AGENT_REASON,
  NoAgent,
  SEED_DISHES,
  type Dish as LlmDish,
  type DishSuggestion,
  type ExistingDish,
  type LlmAgent,
  type SelectDishesInput,
  type SelectedDish,
} from "../llm/index.js";
import type { LunchEntry } from "../types.js";
import { createSeedPicker, resolveExistingDish, resolveSuggestion, type SuggestionOutcome } from "./suggestions.js";
import { quickDayLimitFor, type PlannerSettings } from "./settings.js";
import { weekDates, weekdayOf } from "../week.js";
import { DEFAULT_LANG, t, type Lang } from "../i18n/index.js";
import type { DegradedReasonDraft } from "./degraded.js";

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
  /** The UI language rationales are written in (spec #71). Default: Swedish. */
  language?: Lang;
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
  degradedReasons: DegradedReasonDraft[];
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

/** Favorite and Suggested Dishes only: a Dish that is neither is kept but never planned. */
function toExistingDish(dish: Dish): ExistingDish[] {
  if (!dish.inRotation && !dish.suggested) return [];
  return [
    {
      id: String(dish.id),
      name: dish.name,
      kind: dish.inRotation ? "favorite" : "suggested",
      mainCategory: dish.mainCategory ?? undefined,
      prepTimeMinutes: dish.prepTimeMinutes ?? undefined,
      weekendOnly: dish.weekendOnly,
    },
  ];
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
  degradedReasons: DegradedReasonDraft[],
): Promise<{ picks: SelectedDish[]; fromNoAgent: boolean }> {
  if (llm instanceof NoAgent) degradedReasons.push({ code: "no-agent", date: null, detail: NO_AGENT_REASON });
  const result = await llm.selectDishes(request);
  if (result.ok) return { picks: result.value, fromNoAgent: llm instanceof NoAgent };
  degradedReasons.push({ code: "agent-failed", date: null, detail: result.reason });
  const fallback = await new NoAgent().selectDishes(request);
  return { picks: fallback.ok ? fallback.value : [], fromNoAgent: true };
}

export async function planWeek(input: PlanWeekInput): Promise<PlanWeekResult> {
  const days = toDayInputs(input);
  const candidates = buildCandidateSets(input.dishes, days, {
    categoryCollisionEnabled: input.settings.categoryCollisionEnabled,
  });
  const request: SelectDishesInput = {
    days: days.map((d) => ({
      date: d.date,
      isQuickDay: d.quickDayLimitMinutes !== null,
      quickDayLimitMinutes: d.quickDayLimitMinutes,
      lunch: d.lunch,
    })),
    candidates: candidates.map((c) => c.eligible.map(toCandidate)),
    existingDishes: input.dishes.flatMap(toExistingDish),
    recentlyPlanned: input.recentlyPlanned,
    suggestionStyle: input.settings.suggestionStyle,
    seedDishes: SEED_DISHES,
    language: input.language ?? DEFAULT_LANG,
  };
  const lang = input.language ?? DEFAULT_LANG;
  const noEligibleRationale = t(lang, "rationale.noEligible");
  const seedRationale = t(lang, "rationale.seedFallback");
  const degradedReasons: DegradedReasonDraft[] = [];
  const { picks, fromNoAgent } = await select(input.llm, request, degradedReasons);
  // NoAgent's rationale is a technical marker; write the household's words instead.
  const rationaleOf = (pick: SelectedDish) => (fromNoAgent ? t(lang, "rationale.noAgent") : pick.rationale);
  const pickByDate = new Map(picks.map((p) => [p.date, p]));
  const filterOptions = { categoryCollisionEnabled: input.settings.categoryCollisionEnabled };
  const pickSeed = createSeedPicker(
    SEED_DISHES,
    input.dishes,
    filterOptions,
    input.recentlyPlanned.map((r) => r.name),
  );

  // Once a Week: the dinners planned so far, so a later date never repeats one.
  const planned: PlannedElsewhere[] = [];
  const dinners = days.map((weekDay, i): PlannedDinnerDraft => {
    const draft = planDay({ ...weekDay, plannedElsewhere: [...planned] }, i);
    const asPlanned = plannedElsewhereOf(draft, input.dishes);
    if (asPlanned) planned.push(asPlanned);
    return draft;
  });

  function planDay(day: DayInput, i: number): PlannedDinnerDraft {
    const eligible = candidates[i]?.eligible ?? [];
    const base = {
      date: day.date,
      isQuickDay: day.quickDayLimitMinutes !== null,
      lunchThatDay: day.lunch.length > 0 ? day.lunch.map((l) => l.rawText).join("; ") : null,
    };
    /** The day's dinner: a reused Dish, a new Suggested Dish, or (neither) empty. */
    const dinner = (rationale: string, dishId: number | null = null, suggestion: DishSuggestion | null = null): PlannedDinnerDraft => ({
      ...base,
      dishId,
      suggestion,
      rationale,
    });
    const landed = (outcome: Exclude<SuggestionOutcome, { kind: "dropped" }>, rationale: string) =>
      outcome.kind === "reuse" ? dinner(rationale, outcome.dishId) : dinner(rationale, null, outcome.suggestion);
    const pick = pickByDate.get(day.date);
    let dropped = false;

    /** The seed fallback for the day; `dropped` when another reason already explains the day. */
    const seedFallback = (dropped: boolean): PlannedDinnerDraft => {
      const seed = pickSeed(day);
      if (seed === undefined) return dinner(noEligibleRationale);
      // A dropped pick already explains the day; the seed fallback only goes to Logs then.
      const detail = `${day.date}: seed fallback used`;
      degradedReasons.push(dropped ? { code: "unknown", date: day.date, detail, logOnly: true } : { code: "seed-fallback", date: day.date, detail });
      return landed(seed, seedRationale);
    };

    if (eligible.length === 0) {
      if (pick !== undefined && !fromNoAgent) {
        // The agent may return an existing Dish's id instead of suggesting its twin.
        const existing = "dishId" in pick ? input.dishes.find((d) => String(d.id) === pick.dishId) : undefined;
        const outcome: SuggestionOutcome =
          "suggestion" in pick
            ? resolveSuggestion(pick.suggestion, day, input.dishes, filterOptions)
            : existing !== undefined
              ? resolveExistingDish(existing, day, filterOptions)
              : ({ kind: "dropped", why: `agent picked unknown dish ${pick.dishId}` } as const);
        if (outcome.kind !== "dropped") return landed(outcome, pick.rationale);
        const name = "suggestion" in pick ? String((pick.suggestion as { name?: unknown } | null)?.name ?? "") : (existing?.name ?? "");
        const detail = "suggestion" in pick ? `${day.date}: suggestion "${name}" dropped: ${outcome.why}` : `${day.date}: dish ${pick.dishId} dropped: ${outcome.why}`;
        const { code, params } = droppedCode("suggestion" in pick, outcome.rule);
        degradedReasons.push({ code, date: day.date, params: { name, ...params }, detail });
        dropped = true;
      }
      return seedFallback(dropped);
    }

    if (pick === undefined) return dinner(noEligibleRationale);
    const pickedId = "dishId" in pick ? pick.dishId : undefined;
    const chosen = eligible.find((d) => String(d.id) === pickedId);
    if (chosen === undefined) {
      const reason = `${day.date}: agent picked dish ${pickedId ?? "(suggestion)"}, which is not eligible that day; dropped`;
      degradedReasons.push({ code: "pick-not-eligible", date: day.date, detail: reason });
      return dinner(t(lang, "rationale.pickDropped"));
    }
    const repeat = exclusionRule(chosen, day, filterOptions);
    if (repeat?.code === "once-a-week") {
      const detail = `${day.date}: dish ${chosen.id} is already planned on ${repeat.date}; dropped (Once a Week)`;
      // An agent's pick or NoAgent's round-robin alike: the household sees why the Dish is not on the day.
      degradedReasons.push({ code: "once-a-week", date: day.date, params: { name: chosen.name }, detail });
      return seedFallback(true);
    }
    return dinner(rationaleOf(pick) || noEligibleRationale, chosen.id);
  }

  return { weekStart: input.weekStart, dinners, degradedReasons };
}

/** The household-facing code for a dropped suggestion or existing-Dish pick on a day with no eligible Favorite Dish. */
function droppedCode(wasSuggestion: boolean, rule: ExclusionRule | undefined): Pick<DegradedReasonDraft, "code" | "params"> {
  if (rule === undefined || rule.code === "not-in-rotation") return { code: wasSuggestion ? "suggestion-invalid" : "pick-not-eligible" };
  const params = exclusionParams(rule);
  return params ? { code: rule.code, params } : { code: rule.code };
}
