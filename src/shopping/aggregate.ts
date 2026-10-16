/**
 * Shopping List aggregation (FR-11, NFR-3): pure and LLM-free. Ingredients from all the
 * week's Planned Dinners are merged by normalised name; quantities are summed when every
 * contribution shares one unit, otherwise the individual notes are kept side by side
 * ("2 dl + 1 msk") so nothing is silently lost.
 */
import type { Ingredient } from "../dishes/repo.js";
import { normaliseName } from "../pantry/matching.js";

export interface DishIngredients {
  dishId: number;
  ingredients: Ingredient[];
}

export interface AggregatedItem {
  /** The name as first seen (display form). */
  name: string;
  /** A number as text when summed under one unit, a joined note otherwise, null when no quantity was given. */
  quantity: string | null;
  /** The shared unit of a summed quantity; null for a mixed note or no unit. */
  unit: string | null;
  sourceDishIds: number[];
}

interface Bucket {
  name: string;
  parts: { quantity: number; unit: string | null }[];
  sourceDishIds: number[];
}

export function aggregateIngredients(perDish: DishIngredients[]): AggregatedItem[] {
  const buckets = new Map<string, Bucket>();
  for (const { dishId, ingredients } of perDish) {
    for (const ing of ingredients) {
      const key = normaliseName(ing.name);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { name: ing.name.trim(), parts: [], sourceDishIds: [] };
        buckets.set(key, bucket);
      }
      if (ing.quantity !== null) bucket.parts.push({ quantity: ing.quantity, unit: ing.unit });
      if (!bucket.sourceDishIds.includes(dishId)) bucket.sourceDishIds.push(dishId);
    }
  }
  return [...buckets.values()].map(toItem);
}

function toItem({ name, parts, sourceDishIds }: Bucket): AggregatedItem {
  if (parts.length === 0) return { name, quantity: null, unit: null, sourceDishIds };
  const unit = parts[0]!.unit;
  if (parts.every((p) => p.unit === unit)) {
    const total = parts.reduce((sum, p) => sum + p.quantity, 0);
    return { name, quantity: formatQuantity(total), unit, sourceDishIds };
  }
  return { name, quantity: parts.map((p) => (p.unit ? `${formatQuantity(p.quantity)} ${p.unit}` : formatQuantity(p.quantity))).join(" + "), unit: null, sourceDishIds };
}

function formatQuantity(n: number): string {
  return String(Number(n.toFixed(3)));
}
