/**
 * Suggested Dish rules for the planner seam (ADR-0001 "Suggested Dishes"). Pure: a suggestion
 * from the agent (or the seed list) is validated, re-checked against the day's hard rules by
 * the same engine that filters Favorite Dishes, and name-matched against existing Dishes.
 */
import { isMainCategory } from "../dishes/categories.js";
import type { Dish } from "../dishes/repo.js";
import { filterEligibleDishes, type DayInput, type FilterOptions } from "../engine/filter.js";
import type { DishSuggestion, SeedDish } from "../llm/index.js";
import { normaliseName } from "../text.js";

/** How a suggestion lands on a date: reuse an existing Dish, create a new one, or drop it. */
export type SuggestionOutcome =
  | { kind: "reuse"; dishId: number }
  | { kind: "new"; suggestion: DishSuggestion }
  | { kind: "dropped"; why: string };

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

/** A Dish-shaped record so the hard-rule engine can judge a suggestion like a Favorite Dish. */
function asRotationDish(s: DishSuggestion): Dish {
  return {
    id: -1,
    name: s.name,
    recipeUrl: null,
    adaptationNotes: null,
    prepTimeMinutes: s.prepTimeMinutes ?? null,
    mainCategory: isMainCategory(s.mainCategory) ? s.mainCategory : null,
    inRotation: true,
    preferredDays: [],
    weekendOnly: false,
    ingredients: [],
  };
}

/** The engine's exclusion reason for `dish` on `day`, or null when it passes every hard rule. */
function hardRuleViolation(dish: Dish, day: DayInput, options: FilterOptions): string | null {
  return filterEligibleDishes([dish], day, options).excluded[0]?.reason ?? null;
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
  if (violation !== null) return { kind: "dropped", why: violation };

  const wanted = normaliseName(suggestion.name);
  const match = dishes.find((d) => normaliseName(d.name) === wanted);
  if (match === undefined) return { kind: "new", suggestion };
  if (match.inRotation) {
    const reason = hardRuleViolation(match, day, options) ?? "not eligible that day";
    return { kind: "dropped", why: `matches Favorite Dish "${match.name}", excluded that day (${reason})` };
  }
  const existingViolation = hardRuleViolation({ ...match, inRotation: true }, day, options);
  if (existingViolation !== null) {
    return { kind: "dropped", why: `matches existing Dish "${match.name}", which breaks a hard rule (${existingViolation})` };
  }
  return { kind: "reuse", dishId: match.id };
}

/**
 * Round-robin over the seed list across the week: each call starts after the previous pick and
 * takes the first seed that resolves to a Dish for that day. Returns `undefined` when none does.
 */
export function createSeedPicker(seeds: SeedDish[], dishes: Dish[], options: FilterOptions) {
  let next = 0;
  return (day: DayInput): Exclude<SuggestionOutcome, { kind: "dropped" }> | undefined => {
    for (let k = 0; k < seeds.length; k++) {
      const index = (next + k) % seeds.length;
      const outcome = resolveSuggestion({ ...seeds[index] }, day, dishes, options);
      if (outcome.kind !== "dropped") {
        next = index + 1;
        return outcome;
      }
    }
    return undefined;
  };
}
