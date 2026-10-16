import type {
  FoundRecipe,
  Ingredient,
  LlmAgent,
  LlmResult,
  LunchEntry,
  PantryMatch,
  SelectDishesInput,
  SelectedDish,
} from "./types.js";

export const NO_AGENT_REASON = "no agent configured";

/**
 * The FR-16 fallback when no `agent_command` is configured: extraction-dependent features
 * report themselves unavailable, and selection is a deterministic round-robin over each
 * day's (already deterministically filtered) candidates.
 */
export class NoAgent implements LlmAgent {
  async extractLunchMenu(): Promise<LlmResult<LunchEntry[]>> {
    return { ok: false, reason: NO_AGENT_REASON };
  }

  /** Unavailable regardless of Adaptation notes. */
  async extractIngredients(): Promise<LlmResult<Ingredient[]>> {
    return { ok: false, reason: NO_AGENT_REASON };
  }

  async findRecipe(): Promise<LlmResult<FoundRecipe>> {
    return { ok: false, reason: NO_AGENT_REASON };
  }

  /** Unavailable: every Ingredient the deterministic match missed stays in "Buy". */
  async matchPantryItems(): Promise<LlmResult<PantryMatch[]>> {
    return { ok: false, reason: NO_AGENT_REASON };
  }

  /** Round-robin: each day takes the least-used candidate so far (ties by candidate order). */
  async selectDishes(input: SelectDishesInput): Promise<LlmResult<SelectedDish[]>> {
    const uses = new Map<string, number>();
    const value: SelectedDish[] = [];
    input.days.forEach((day, i) => {
      const candidates = input.candidates[i] ?? [];
      let pick: string | undefined;
      let best = Infinity;
      for (const c of candidates) {
        const id = String(c.id);
        const n = uses.get(id) ?? 0;
        if (n < best) {
          best = n;
          pick = id;
        }
      }
      if (pick === undefined) return;
      uses.set(pick, best + 1);
      value.push({ date: day.date, dishId: pick, rationale: NO_AGENT_REASON });
    });
    return { ok: true, value };
  }
}
