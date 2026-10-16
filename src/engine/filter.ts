/**
 * Deterministic constraint engine (ADR-0001 stage one, FR-6, NFR-3). Pure: no LLM, no DB,
 * no network. Filters Favorite Dishes per dinner date by the hard rules; the LLM selection
 * step (FR-7) picks among what is left.
 */
import { WEEKDAYS, type Dish, type Weekday } from "../dishes/repo.js";
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

/** Weekday key of an ISO `YYYY-MM-DD` date, UTC-safe (no local-timezone drift). */
export function weekdayOf(date: string): Weekday {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(index + 6) % 7]!;
}

/** Exact-normalised comparison: trim, lowercase, collapse whitespace. No diacritic folding. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function lunchNameMatch(dish: Dish, lunch: LunchEntry[]): LunchEntry | undefined {
  const wanted = normalizeName(dish.name);
  return lunch.find(
    (entry) =>
      normalizeName(entry.rawText) === wanted ||
      (entry.normalizedName !== undefined && normalizeName(entry.normalizedName) === wanted),
  );
}

/** FR-6b: `other` means uncategorised and never collides, on either side. */
function categoryCollision(dish: Dish, lunch: LunchEntry[]): LunchEntry | undefined {
  const category = dish.mainCategory;
  if (category === null || category === "other") return undefined;
  return lunch.find((entry) => entry.mainCategory === category);
}

function exclusionReason(dish: Dish, day: DayInput, options: FilterOptions): string | null {
  if (!dish.inRotation) return "not in rotation";
  const sameName = lunchNameMatch(dish, day.lunch);
  if (sameName) return `same dish as lunch "${sameName.rawText}"`;
  if (options.categoryCollisionEnabled) {
    const collision = categoryCollision(dish, day.lunch);
    if (collision) return `same Main Category (${dish.mainCategory}) as lunch "${collision.rawText}"`;
  }
  if (dish.weekendOnly && !isWeekend(day.weekday)) return `Weekend Dish, and ${day.date} is a ${day.weekday}`;
  if (day.quickDayLimitMinutes !== null) {
    const limit = day.quickDayLimitMinutes;
    // Decision: a Dish with no prep time cannot be shown to be fast enough, so it is excluded
    // on Quick Days (see the notes README, ticket #25).
    if (dish.prepTimeMinutes === null) return `Quick Day (limit ${limit} min) and prep time is unknown`;
    if (dish.prepTimeMinutes > limit) return `Quick Day (limit ${limit} min) and prep time is ${dish.prepTimeMinutes} min`;
  }
  return null;
}

function isWeekend(weekday: Weekday): boolean {
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
