/**
 * Builds a Weekly Plan's Shopping List (FR-11): resolve each Planned Dinner's Ingredients
 * (FR-10), aggregate (pure), match Pantry Items (deterministic first, LLM second), split
 * into Buy / Check pantry, and store the rows for the plan (replacing any earlier build).
 * Resolution failures degrade: the Dish is left out and named in `degradedReasons`.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { resolvePlanIngredients, type ResolveDeps } from "../ingredients/resolve.js";
import { matchPantry } from "../pantry/matching.js";
import { listPantryItems } from "../pantry/repo.js";
import { getPlanById } from "../planner/repo.js";
import { aggregateIngredients, type AggregatedItem, type DishIngredients } from "./aggregate.js";
import { applyEdits, type ShoppingLine, type StoredShoppingList } from "./edits.js";
import { splitSections, type ShoppingSections } from "./split.js";

export type ShoppingListDeps = ResolveDeps;

export interface ShoppingList extends ShoppingSections {
  degradedReasons: string[];
  /** Ids of the planned Dishes that resolved to no Ingredients. */
  missingDishIds: number[];
}

export type Section = "buy" | "check_pantry";

interface ItemRow {
  name: string;
  quantity: string | null;
  unit: string | null;
  section: Section;
  source_dish_ids: string;
}

/**
 * `freshDishIds`: Dishes re-resolved past their caches, for Försök igen on the Dishes the
 * last build recorded as missing; every other Dish resolves as usual (cached when it can).
 */
export async function buildShoppingList(deps: ShoppingListDeps, planId: number, freshDishIds?: ReadonlySet<number>): Promise<ShoppingList> {
  // #30: also writes LLM-found recipe source links to planned_dinner.source_url.
  const entries = await resolvePlanIngredients(deps, planId, freshDishIds);

  const perDish: DishIngredients[] = [];
  const degradedReasons: string[] = [];
  const missingDishIds: number[] = [];
  const seen = new Set<number>();
  for (const { dish, resolved } of entries) {
    if (seen.has(dish.id)) continue;
    seen.add(dish.id);
    if (resolved.ingredients.length === 0) missingDishIds.push(dish.id);
    perDish.push({ dishId: dish.id, ingredients: resolved.ingredients });
    if (resolved.degradedReason) degradedReasons.push(`${dish.name}: ${resolved.degradedReason}`);
  }

  const items = aggregateIngredients(perDish);
  deps.onProgress?.({ phase: "pantry-matching" });
  const matches = await matchPantry(
    items.map((item) => item.name),
    listPantryItems(deps.db),
    deps.llm,
  );
  const sections = splitSections(items, matches);
  replaceItems(deps.db, planId, sections, missingDishIds);
  return { ...sections, degradedReasons, missingDishIds };
}

/** The planned Dishes that resolved to no Ingredients at the plan's last build, in plan order. */
export function getMissingDishIds(db: Database.Database, planId: number): number[] {
  const rows = db.prepare("SELECT dish_id FROM shopping_list_missing WHERE plan_id = ? ORDER BY rowid").all(planId) as { dish_id: number }[];
  return rows.map((r) => r.dish_id);
}

/**
 * The stored list for a plan with the week's edits applied (Checked Off, Removed Lines, Extra
 * Items); empty sections when it has not been built.
 */
export function getShoppingList(db: Database.Database, planId: number): StoredShoppingList {
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
  const weekStart = getPlanById(db, planId)?.weekStart;
  return applyEdits(db, weekStart, sections);
}

/**
 * A stable fingerprint of what a push sends, recorded with each push so the view can tell the
 * list changed since. Checked Off is never pushed, so a tick does not change it.
 */
export function buyFingerprint(buy: ShoppingLine[]): string {
  return createHash("sha256").update(JSON.stringify(buy.map(pushedItem))).digest("hex");
}

/** The line as a sink receives it: the Ingredient fields only, no tick and no Extra Item id. */
export function pushedItem({ name, quantity, unit, sourceDishIds }: ShoppingLine): AggregatedItem {
  return { name, quantity, unit, sourceDishIds };
}

function replaceItems(db: Database.Database, planId: number, { buy, checkPantry }: ShoppingSections, missingDishIds: number[]): void {
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
    db.prepare("DELETE FROM shopping_list_missing WHERE plan_id = ?").run(planId);
    for (const dishId of missingDishIds) db.prepare("INSERT INTO shopping_list_missing (plan_id, dish_id) VALUES (?, ?)").run(planId, dishId);
    insertAll(buy, "buy");
    insertAll(checkPantry, "check_pantry");
  })();
}
