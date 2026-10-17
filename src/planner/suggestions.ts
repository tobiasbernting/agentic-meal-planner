/**
 * Suggested Dish rules for the planner seam (ADR-0001 "Suggested Dishes"). Pure: a suggestion
 * from the agent (or the seed list) is validated, re-checked against the day's hard rules by
 * the same engine that filters Favorite Dishes, and name-matched against existing Dishes.
 */
import { isMainCategory } from "../dishes/categories.js";
import type { Dish } from "../dishes/repo.js";
import { describeExclusion, exclusionRule, type DayInput, type ExclusionRule, type FilterOptions } from "../engine/filter.js";
import type { DishSuggestion, SeedDish } from "../llm/index.js";
import { normaliseName } from "../text.js";

/**
 * How a suggestion lands on a date: reuse an existing Dish, create a new one, or drop it. A drop
 * carries the hard rule it broke (`rule`), absent when the suggestion itself was malformed.
 */
export type SuggestionOutcome =
  | { kind: "reuse"; dishId: number }
  | { kind: "new"; suggestion: DishSuggestion }
  | { kind: "dropped"; why: string; rule?: ExclusionRule };

/** Shape check: non-empty name, a fixed Main Category key, prep time a positive integer or absent. */
export function validateSuggestion(raw: unknown): { ok: true; value: DishSuggestion } | { ok: false; why: string } {
  if (raw === null || typeof raw !== "object") return { ok: false, why: "not an object" };
  const { name, mainCategory, prepTimeMinutes } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return { ok: false, why: "name is empty" };
  if (typeof mainCategory !== "string" || !isMainCategory(mainCategory)) {
    return { ok: false, why: `Main Category ${JSON.stringify(mainCategory)} is not on the fixed list` };
  }
  if (prepTimeMinutes !== undefined && prepTimeMinutes !== null) {
    if (typeof prepTimeMinutes !== "number" || !Number.isInteger(prepTimeMinutes) || prepTimeMinutes <= 0) {
      return { ok: false, why: `prep time ${JSON.stringify(prepTimeMinutes)} is not a positive integer` };
    }
    return { ok: true, value: { name: name.trim(), mainCategory, prepTimeMinutes } };
  }
  return { ok: true, value: { name: name.trim(), mainCategory } };
}

/**
 * Id of the throwaway Dish record built from a suggestion: never stored and never matched
 * against real Dishes; the hard-rule engine only needs some id to report against.
 */
const UNSAVED_SUGGESTION_ID = -1;

/** A Dish-shaped record so the hard-rule engine can judge a suggestion like a Favorite Dish. */
function asRotationDish(s: DishSuggestion): Dish {
  return {
    id: UNSAVED_SUGGESTION_ID,
    name: s.name,
    recipeUrl: null,
    adaptationNotes: null,
    prepTimeMinutes: s.prepTimeMinutes ?? null,
    mainCategory: isMainCategory(s.mainCategory) ? s.mainCategory : null,
    inRotation: true,
    suggested: true,
    preferredDays: [],
    weekendOnly: false,
    ingredients: [],
  };
}

/** The hard rule `dish` breaks on `day`, or null when it passes every one. */
function hardRuleViolation(dish: Dish, day: DayInput, options: FilterOptions): ExclusionRule | null {
  return exclusionRule(dish, day, options);
}

/**
 * Decides what a suggestion becomes on one date. `dishes` is every Dish (in rotation or not).
 * A name match to a Favorite Dish means the filter already excluded it that day, so the pick
 * is dropped; a match to any other Dish is reused once that Dish itself passes the hard rules.
 */
export function resolveSuggestion(
  raw: unknown,
  day: DayInput,
  dishes: Dish[],
  options: FilterOptions,
): SuggestionOutcome {
  const valid = validateSuggestion(raw);
  if (!valid.ok) return { kind: "dropped", why: valid.why };
  const suggestion = valid.value;
  const violation = hardRuleViolation(asRotationDish(suggestion), day, options);
  if (violation !== null) return { kind: "dropped", why: describeExclusion(violation), rule: violation };

  const wanted = normaliseName(suggestion.name);
  const match = dishes.find((d) => normaliseName(d.name) === wanted);
  if (match === undefined) return { kind: "new", suggestion };
  if (match.inRotation) {
    const rule = hardRuleViolation(match, day, options) ?? undefined;
    const reason = rule ? describeExclusion(rule) : "not eligible that day";
    return { kind: "dropped", why: `matches Favorite Dish "${match.name}", excluded that day (${reason})`, rule };
  }
  const existingViolation = hardRuleViolation({ ...match, inRotation: true }, day, options);
  if (existingViolation !== null) {
    return {
      kind: "dropped",
      why: `matches existing Dish "${match.name}", which breaks a hard rule (${describeExclusion(existingViolation)})`,
      rule: existingViolation,
    };
  }
  return { kind: "reuse", dishId: match.id };
}

/**
 * Round-robin over the seed list across the week: each call starts after the previous pick and
 * takes the first seed that resolves to a Dish for that day, preferring seeds whose name is not
 * in `recentNames` (Variety Preference). Returns `undefined` when none resolves.
 */
export function createSeedPicker(seeds: SeedDish[], dishes: Dish[], options: FilterOptions, recentNames: string[] = []) {
  const recent = new Set(recentNames.map(normaliseName));
  let next = 0;
  const pass = (day: DayInput, skipRecent: boolean) => {
    for (let k = 0; k < seeds.length; k++) {
      const index = (next + k) % seeds.length;
      const seed = seeds[index]!;
      if (skipRecent && recent.has(normaliseName(seed.name))) continue;
      const outcome = resolveSuggestion({ ...seed }, day, dishes, options);
      if (outcome.kind !== "dropped") {
        next = index + 1;
        return outcome;
      }
    }
    return undefined;
  };
  return (day: DayInput): Exclude<SuggestionOutcome, { kind: "dropped" }> | undefined => pass(day, true) ?? pass(day, false);
}
