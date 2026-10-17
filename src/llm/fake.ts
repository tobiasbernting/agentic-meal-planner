import type { MainCategory } from "../dishes/categories.js";
import type {
  ExtractIngredientsOptions,
  FoundRecipe,
  Ingredient,
  LlmAgent,
  LlmResult,
  LunchEntry,
  MatchPantryInput,
  PantryMatch,
  SelectDishesInput,
  SelectedDish,
} from "./types.js";

/**
 * A fixed result, or a function of the call's arguments. The function may return a Promise,
 * so a test can hold a Plan Run inside an agent call and release it later.
 */
type Scripted<Args extends unknown[], T> = LlmResult<T> | ((...args: Args) => LlmResult<T> | Promise<LlmResult<T>>);

export interface ScriptedResponses {
  extractLunchMenu?: Scripted<[pageContent: string, weekStart: string], LunchEntry[]>;
  extractIngredients?: Scripted<[recipePageContent: string, options: ExtractIngredientsOptions], Ingredient[]>;
  findRecipe?: Scripted<[dishName: string, options: ExtractIngredientsOptions], FoundRecipe>;
  selectDishes?: Scripted<[input: SelectDishesInput], SelectedDish[]>;
  suggestMainCategory?: Scripted<[dishName: string, candidates: MainCategory[]], MainCategory | null>;
  matchPantryItems?: Scripted<[input: MatchPantryInput], PantryMatch[]>;
}

export interface ScriptedCall {
  method: keyof ScriptedResponses;
  args: unknown[];
}

/**
 * Test double for other features' tests: responses are supplied per method (a fixed
 * result or a function of the arguments, sync or async). An unscripted method degrades, and every call
 * is recorded in `calls`.
 */
export class ScriptedLlmAgent implements LlmAgent {
  readonly calls: ScriptedCall[] = [];

  constructor(private readonly responses: ScriptedResponses = {}) {}

  extractLunchMenu(pageContent: string, weekStart: string) {
    return this.reply("extractLunchMenu", [pageContent, weekStart]);
  }

  extractIngredients(recipePageContent: string, options: ExtractIngredientsOptions = {}) {
    return this.reply("extractIngredients", [recipePageContent, options]);
  }

  findRecipe(dishName: string, options: ExtractIngredientsOptions = {}) {
    return this.reply("findRecipe", [dishName, options]);
  }

  selectDishes(input: SelectDishesInput) {
    return this.reply("selectDishes", [input]);
  }

  suggestMainCategory(dishName: string, candidates: MainCategory[]) {
    return this.reply("suggestMainCategory", [dishName, candidates]);
  }

  matchPantryItems(input: MatchPantryInput) {
    return this.reply("matchPantryItems", [input]);
  }

  private async reply<M extends keyof ScriptedResponses>(
    method: M,
    args: Parameters<Extract<ScriptedResponses[M], (...a: never[]) => unknown>>,
  ): Promise<Extract<ScriptedResponses[M], { ok: boolean }>> {
    this.calls.push({ method, args });
    const scripted = this.responses[method] as Scripted<typeof args, unknown> | undefined;
    if (scripted === undefined) {
      return { ok: false, reason: `no scripted response for ${method}` } as Extract<ScriptedResponses[M], { ok: boolean }>;
    }
    const result = typeof scripted === "function" ? await scripted(...args) : scripted;
    return result as Extract<ScriptedResponses[M], { ok: boolean }>;
  }
}
