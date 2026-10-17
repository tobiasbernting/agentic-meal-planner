/**
 * Deterministic constraint engine (ADR-0001 stage one, FR-6, NFR-3). Pure: no LLM, no DB,
 * no network. Filters Favorite Dishes per dinner date by the hard rules; the LLM selection
 * step (FR-7) picks among what is left.
 */
import type { Dish, Weekday } from "../dishes/repo.js";
import { normaliseName } from "../text.js";
import type { LunchEntry } from "../types.js";

/** One dinner date's inputs to the filter. */
export interface DayInput {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  weekday: Weekday;
  /** Quick Day prep-time limit in minutes; `null` when the date is not a Quick Day. */
  quickDayLimitMinutes: number | null;
  /** That date's Lunch Entries across all active Schools. */
  lunch: LunchEntry[];
  /** Once a Week: the dinners already planned on the Weekly Plan's other dates. */
  plannedElsewhere?: PlannedElsewhere[];
}

/** A dinner planned on another date of the same Weekly Plan. */
export interface PlannedElsewhere {
  date: string;
  /** `null` for a new Suggested Dish not yet stored; it is then matched by name. */
  dishId: number | null;
  name: string;
}

export interface FilterOptions {
  /** FR-6b: Main Category collision rule on/off (settings `category_collision_enabled`). */
  categoryCollisionEnabled: boolean;
}

export interface Exclusion {
  dish: Dish;
  /** Human-readable, used downstream as rationale. */
  reason: string;
}

export interface FilterResult {
  eligible: Dish[];
  excluded: Exclusion[];
}

function lunchNameMatch(dish: Dish, lunch: LunchEntry[]): LunchEntry | undefined {
  const wanted = normaliseName(dish.name);
  return lunch.find(
    (entry) =>
      normaliseName(entry.rawText) === wanted ||
      (entry.normalizedName !== undefined && normaliseName(entry.normalizedName) === wanted),
  );
}

/** Once a Week: the other date `dish` is already planned on, matched by id or, failing that, by name. */
function plannedOn(dish: Dish, planned: PlannedElsewhere[]): PlannedElsewhere | undefined {
  const wanted = normaliseName(dish.name);
  return planned.find((p) => (p.dishId !== null && p.dishId === dish.id) || normaliseName(p.name) === wanted);
}

/** FR-6b: `other` means uncategorised and never collides, on either side. */
function categoryCollision(dish: Dish, lunch: LunchEntry[]): LunchEntry | undefined {
  const category = dish.mainCategory;
  if (category === null || category === "other") return undefined;
  return lunch.find((entry) => entry.mainCategory === category);
}

/** Which hard rule excludes a Dish on a day, with what the household message needs. */
export type ExclusionRule =
  | { code: "not-in-rotation" }
  | { code: "once-a-week"; date: string }
  | { code: "same-as-lunch"; lunch: string }
  | { code: "lunch-category"; category: string; lunch: string }
  | { code: "weekend-only"; date: string; weekday: Weekday }
  | { code: "quick-day"; limit: number; minutes: number | null };

/** FR-6: the first hard rule `dish` breaks on `day`, or null when it is eligible. */
export function exclusionRule(dish: Dish, day: DayInput, options: FilterOptions): ExclusionRule | null {
  if (!dish.inRotation) return { code: "not-in-rotation" };
  const sameName = lunchNameMatch(dish, day.lunch);
  if (sameName) return { code: "same-as-lunch", lunch: sameName.rawText };
  if (options.categoryCollisionEnabled) {
    const collision = categoryCollision(dish, day.lunch);
    if (collision) return { code: "lunch-category", category: dish.mainCategory!, lunch: collision.rawText };
  }
  if (dish.weekendOnly && !isWeekend(day.weekday)) return { code: "weekend-only", date: day.date, weekday: day.weekday };
  // Decision: a Dish with no prep time cannot be shown to be fast enough, so it is excluded
  // on Quick Days (see the notes README, ticket #25).
  if (day.quickDayLimitMinutes !== null && (dish.prepTimeMinutes === null || dish.prepTimeMinutes > day.quickDayLimitMinutes)) {
    return { code: "quick-day", limit: day.quickDayLimitMinutes, minutes: dish.prepTimeMinutes };
  }
  // Once a Week comes last: a rule about the day itself explains a drop better than a repeat does.
  const elsewhere = plannedOn(dish, day.plannedElsewhere ?? []);
  if (elsewhere) return { code: "once-a-week", date: elsewhere.date };
  return null;
}

export type ExclusionCode = ExclusionRule["code"];
type RuleOf<C extends ExclusionCode> = Extract<ExclusionRule, { code: C }>;
type Params = Record<string, string | number>;

/**
 * Per rule: its technical text (Logs, rationale debugging) and the parameters a household
 * message about it needs (`undefined` when the message needs none).
 */
const RULES: { [C in ExclusionCode]: { describe(rule: RuleOf<C>): string; params(rule: RuleOf<C>): Params | undefined } } = {
  "not-in-rotation": { describe: () => "not in rotation", params: () => undefined },
  "once-a-week": { describe: (r) => `already planned on ${r.date} (Once a Week)`, params: () => undefined },
  "same-as-lunch": { describe: (r) => `same dish as lunch "${r.lunch}"`, params: () => undefined },
  "lunch-category": { describe: (r) => `same Main Category (${r.category}) as lunch "${r.lunch}"`, params: (r) => ({ category: r.category }) },
  "weekend-only": { describe: (r) => `Weekend Dish, and ${r.date} is a ${r.weekday}`, params: () => undefined },
  "quick-day": {
    describe: (r) =>
      r.minutes === null
        ? `Quick Day (limit ${r.limit} min) and prep time is unknown`
        : `Quick Day (limit ${r.limit} min) and prep time is ${r.minutes} min`,
    params: (r) => ({ limit: r.limit }),
  },
};

/** One rule's entry, typed for the union (TypeScript cannot correlate `RULES[rule.code]` with `rule`). */
function ruleEntry(rule: ExclusionRule): { describe(rule: ExclusionRule): string; params(rule: ExclusionRule): Params | undefined } {
  return RULES[rule.code] as { describe(rule: ExclusionRule): string; params(rule: ExclusionRule): Params | undefined };
}

/** The rule as technical text for Logs and rationale debugging. */
export function describeExclusion(rule: ExclusionRule): string {
  return ruleEntry(rule).describe(rule);
}

/** The parameters a household message about the rule needs, or `undefined` when it needs none. */
export function exclusionParams(rule: ExclusionRule): Params | undefined {
  return ruleEntry(rule).params(rule);
}

function exclusionReason(dish: Dish, day: DayInput, options: FilterOptions): string | null {
  const rule = exclusionRule(dish, day, options);
  return rule === null ? null : describeExclusion(rule);
}

/** Saturday or Sunday: the days a Weekend Dish may be planned and no School serves lunch. */
export function isWeekend(weekday: Weekday): boolean {
  return weekday === "sat" || weekday === "sun";
}

/** FR-6: the hard rules for one dinner date. Every exclusion carries a reason. */
export function filterEligibleDishes(dishes: Dish[], day: DayInput, options: FilterOptions): FilterResult {
  const eligible: Dish[] = [];
  const excluded: Exclusion[] = [];
  for (const dish of dishes) {
    const reason = exclusionReason(dish, day, options);
    if (reason === null) eligible.push(dish);
    else excluded.push({ dish, reason });
  }
  return { eligible, excluded };
}

export interface DayCandidates extends FilterResult {
  date: string;
  weekday: Weekday;
}

/** Week-level helper: one `filterEligibleDishes` result per day, in input order. */
export function buildCandidateSets(dishes: Dish[], days: DayInput[], options: FilterOptions): DayCandidates[] {
  return days.map((day) => ({ date: day.date, weekday: day.weekday, ...filterEligibleDishes(dishes, day, options) }));
}
