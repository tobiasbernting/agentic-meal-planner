/**
 * Builds a Weekly Plan's Shopping List (FR-11): resolve each Planned Dinner's Ingredients
 * (FR-10), aggregate (pure), match Pantry Items (deterministic first, LLM second), split
 * into Buy / Check pantry, and store the rows for the plan (replacing any earlier build).
 * Resolution failures degrade: the Dish is left out and named in `degradedReasons`.
 */
import type Database from "better-sqlite3";
import { getDish } from "../dishes/repo.js";
import { resolveWeek, type ResolveDeps } from "../ingredients/resolve.js";
import { matchPantry } from "../pantry/matching.js";
import { listPantryItems } from "../pantry/repo.js";
import { aggregateIngredients, type AggregatedItem, type DishIngredients } from "./aggregate.js";
import { splitSections, type ShoppingSections } from "./split.js";

export type ShoppingListDeps = ResolveDeps;

export interface ShoppingList extends ShoppingSections {
  degradedReasons: string[];
}

export type Section = "buy" | "check_pantry";

interface ItemRow {
  name: string;
  quantity: string | null;
  unit: string | null;
  section: Section;
  source_dish_ids: string;
}

export async function buildShoppingList(deps: ShoppingListDeps, planId: number): Promise<ShoppingList> {
  const dishes = plannedDishes(deps.db, planId);
  // TODO(merge #30): switch to `resolvePlanIngredients(deps, planId)` from src/ingredients/ once it lands.
  const resolved = await resolveWeek(deps, dishes);

  const perDish: DishIngredients[] = [];
  const degradedReasons: string[] = [];
  resolved.forEach((result, i) => {
    const dish = dishes[i]!;
    perDish.push({ dishId: dish.id, ingredients: result.ingredients });
    if (result.degradedReason) degradedReasons.push(`${dish.name}: ${result.degradedReason}`);
  });

  const items = aggregateIngredients(perDish);
  const matches = await matchPantry(
    items.map((item) => item.name),
    listPantryItems(deps.db),
    deps.llm,
  );
  const sections = splitSections(items, matches);
  replaceItems(deps.db, planId, sections);
  return { ...sections, degradedReasons };
}

/** The stored list for a plan; empty sections when it has not been built. */
export function getShoppingList(db: Database.Database, planId: number): ShoppingSections {
  const rows = db
    .prepare("SELECT name, quantity, unit, section, source_dish_ids FROM shopping_list_item WHERE plan_id = ? ORDER BY position")
    .all(planId) as ItemRow[];
  const sections: ShoppingSections = { buy: [], checkPantry: [] };
  for (const row of rows) {
    const item: AggregatedItem = {
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      sourceDishIds: JSON.parse(row.source_dish_ids) as number[],
    };
    (row.section === "buy" ? sections.buy : sections.checkPantry).push(item);
  }
  return sections;
}

function plannedDishes(db: Database.Database, planId: number) {
  const rows = db
    .prepare("SELECT dish_id FROM planned_dinner WHERE plan_id = ? AND dish_id IS NOT NULL ORDER BY date")
    .all(planId) as { dish_id: number }[];
  const seen = new Set<number>();
  return rows
    .filter((r) => !seen.has(r.dish_id) && seen.add(r.dish_id))
    .map((r) => getDish(db, r.dish_id))
    .filter((dish) => dish !== undefined);
}

function replaceItems(db: Database.Database, planId: number, { buy, checkPantry }: ShoppingSections): void {
  db.transaction(() => {
    db.prepare("DELETE FROM shopping_list_item WHERE plan_id = ?").run(planId);
    const insert = db.prepare(
      `INSERT INTO shopping_list_item (plan_id, position, name, quantity, unit, section, source_dish_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let position = 0;
    const insertAll = (items: AggregatedItem[], section: Section) => {
      for (const item of items) {
        insert.run(planId, position++, item.name, item.quantity, item.unit, section, JSON.stringify(item.sourceDishIds));
      }
    };
    insertAll(buy, "buy");
    insertAll(checkPantry, "check_pantry");
  })();
}
