import type { LlmAgent } from "../llm/index.js";
import { normaliseName } from "../text.js";
import type { PantryItem } from "./repo.js";

/**
 * The deterministic Pantry match: a lookup from a name to the Pantry Item whose normalised
 * name or alias equals it. The first item listed wins a shared key.
 */
export function pantryLookup(items: PantryItem[]): (name: string) => PantryItem | undefined {
  const byKey = new Map<string, PantryItem>();
  for (const item of items) {
    for (const key of [item.name, ...item.aliases].map(normaliseName)) {
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }
  return (name) => byKey.get(normaliseName(name));
}

/**
 * Maps each Ingredient name to the Pantry Item it belongs to, or null for "Buy" (FR-11).
 * First an exact match on the normalised name or any alias; whatever is left goes to
 * the LLM in one call. If the LLM degrades, or answers with an unknown pantry id, the
 * Ingredient stays unmatched: a miss only ever costs a "Buy" line.
 */
export async function matchPantry(
  ingredientNames: string[],
  items: PantryItem[],
  llm: LlmAgent,
): Promise<Map<string, PantryItem | null>> {
  const lookup = pantryLookup(items);
  const result = new Map<string, PantryItem | null>();
  const unmatched: string[] = [];
  for (const name of ingredientNames) {
    const hit = lookup(name) ?? null;
    result.set(name, hit);
    if (!hit) unmatched.push(name);
  }
  if (unmatched.length === 0 || items.length === 0) return result;

  const byId = new Map(items.map((item) => [String(item.id), item]));
  const judged = await llm.matchPantryItems({
    ingredients: unmatched,
    pantry: items.map((item) => ({ id: String(item.id), name: item.name, aliases: item.aliases })),
  });
  if (!judged.ok) return result;

  const asked = new Set(unmatched);
  for (const match of judged.value) {
    if (!asked.has(match.ingredient) || match.pantryId === null) continue;
    const item = byId.get(match.pantryId);
    if (item) result.set(match.ingredient, item);
  }
  return result;
}
