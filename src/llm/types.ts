/**
 * The LlmAgent port (ADR-0005, FR-16). Every LLM call in the Planner Agent goes through
 * this interface; the production implementation shells out to the configured agent CLI
 * and the fallback degrades deterministically. Dates are ISO `YYYY-MM-DD` strings.
 */

/** A degradable result: callers get `{ ok: false, reason }` instead of a thrown error. */
export type LlmResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** One line item a Dish requires (GLOSSARY: Ingredient). */
export interface Ingredient {
  name: string;
  quantity?: number | string;
  unit?: string;
}

/** What a School serves on one date (GLOSSARY: Lunch Entry). Minimal structural shape. */
export interface LunchEntry {
  date: string;
  rawText: string;
  normalizedName?: string;
  mainCategory?: string;
}

/** The minimal shape of a Dish that selection needs (structural; `src/dishes` rows satisfy it). */
export interface Dish {
  id: string | number;
  name: string;
  mainCategory?: string;
  prepTimeMinutes?: number;
}

export interface SelectDishesInput {
  days: { date: string; isQuickDay: boolean; lunch: LunchEntry[] }[];
  /** Per day, pre-filtered by the deterministic engine; same index as `days`. */
  candidates: Dish[][];
  /** Soft variety preference. */
  recentlyPlanned: { dishId: string; lastDate: string }[];
}

export interface SelectedDish {
  date: string;
  /** `String(dish.id)` of the chosen candidate. */
  dishId: string;
  rationale: string;
}

export interface FoundRecipe {
  url: string;
  ingredients: Ingredient[];
}

/** Ingredients the deterministic pantry match could not place, plus the whole pantry (FR-11). */
export interface MatchPantryInput {
  ingredients: string[];
  pantry: { id: string; name: string; aliases: string[] }[];
}

/** One judgement per ingredient: `pantryId` is an id from the input pantry, or null for "Buy". */
export interface PantryMatch {
  ingredient: string;
  pantryId: string | null;
}

/** Options for Ingredient extraction: the Dish's Adaptation notes are applied during extraction (ADR-0003). */
export interface ExtractIngredientsOptions {
  adaptationNotes?: string;
}

export interface LlmAgent {
  extractLunchMenu(pageContent: string, weekStart: string): Promise<LlmResult<LunchEntry[]>>;
  extractIngredients(recipePageContent: string, options?: ExtractIngredientsOptions): Promise<LlmResult<Ingredient[]>>;
  /** Used when a Dish has neither a recipe URL nor manual Ingredients. Adaptation notes apply during extraction (ADR-0003). */
  findRecipe(dishName: string, options?: ExtractIngredientsOptions): Promise<LlmResult<FoundRecipe>>;
  selectDishes(input: SelectDishesInput): Promise<LlmResult<SelectedDish[]>>;
  /** Judges the Ingredients the deterministic name/alias match missed (FR-11). */
  matchPantryItems(input: MatchPantryInput): Promise<LlmResult<PantryMatch[]>>;
}
