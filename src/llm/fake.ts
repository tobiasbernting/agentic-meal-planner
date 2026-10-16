import type {
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

type Scripted<Args extends unknown[], T> = LlmResult<T> | ((...args: Args) => LlmResult<T>);

export interface ScriptedResponses {
  extractLunchMenu?: Scripted<[pageContent: string, weekStart: string], LunchEntry[]>;
  extractIngredients?: Scripted<[recipePageContent: string], Ingredient[]>;
  findRecipe?: Scripted<[dishName: string], FoundRecipe>;
  selectDishes?: Scripted<[input: SelectDishesInput], SelectedDish[]>;
  matchPantryItems?: Scripted<[input: MatchPantryInput], PantryMatch[]>;
}

export interface ScriptedCall {
  method: keyof ScriptedResponses;
  args: unknown[];
}

/**
 * Test double for other features' tests: responses are supplied per method (a fixed
 * result or a function of the arguments). An unscripted method degrades, and every call
 * is recorded in `calls`.
 */
export class ScriptedLlmAgent implements LlmAgent {
  readonly calls: ScriptedCall[] = [];

  constructor(private readonly responses: ScriptedResponses = {}) {}

  extractLunchMenu(pageContent: string, weekStart: string) {
    return this.reply("extractLunchMenu", [pageContent, weekStart]);
  }

  extractIngredients(recipePageContent: string) {
    return this.reply("extractIngredients", [recipePageContent]);
  }

  findRecipe(dishName: string) {
    return this.reply("findRecipe", [dishName]);
  }

  selectDishes(input: SelectDishesInput) {
    return this.reply("selectDishes", [input]);
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
    const result = typeof scripted === "function" ? scripted(...args) : scripted;
    return result as Extract<ScriptedResponses[M], { ok: boolean }>;
  }
}
