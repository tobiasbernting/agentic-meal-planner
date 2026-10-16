/**
 * Splits the aggregated Shopping List into "Buy" and "Check pantry" (FR-11): an item
 * that matched a Pantry Item is checked at home, never bought; a miss costs a Buy line.
 * An item lands in exactly one section.
 */
import type { PantryItem } from "../pantry/repo.js";
import type { AggregatedItem } from "./aggregate.js";

export interface ShoppingSections {
  buy: AggregatedItem[];
  checkPantry: AggregatedItem[];
}

export function splitSections(
  items: AggregatedItem[],
  pantryMatches: Map<string, PantryItem | null>,
): ShoppingSections {
  const buy: AggregatedItem[] = [];
  const checkPantry: AggregatedItem[] = [];
  for (const item of items) (pantryMatches.get(item.name) ? checkPantry : buy).push(item);
  return { buy, checkPantry };
}
