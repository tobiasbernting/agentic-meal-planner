/**
 * Shares (ADR-0009): one Planned Dinner's claim on a Shopping List line. The Plan Run's
 * Shopping List update adds Shares once per Planned Dinner and never deletes a line or clears
 * a tick on its own; a Swap or regenerate withdraws the old dinner's Shares. Lines leave the
 * list only by the household's Delete or Clear.
 *
 * Reconciliation rules, applied by `updateShoppingList`:
 * - a Share whose Planned Dinner no longer exists, or whose dinner now has another Dish (Swap,
 *   Dish deleted), is withdrawn;
 * - a dinner with no Share (live or tombstone) gets Shares for its Ingredients;
 * - a dinner that already has Shares for its Dish is left alone, so a re-run is a no-op;
 * - after all of that, a line with no Shares and not hand-added is deleted if unticked and kept
 *   (as hand-added) if ticked; a ticked line that now needs more is un-ticked.
 */
import { recordActivity } from "../lists/activity.js";
import type Database from "better-sqlite3";
import { getDish } from "../dishes/repo.js";
import type { Ingredient } from "../dishes/repo.js";
import { resolveIngredients, type ResolveDeps } from "../ingredients/resolve.js";
import { matchPantry, pantryLookup } from "../pantry/matching.js";
import { listPantryItems } from "../pantry/repo.js";
import { createItem, findItemByName, getItem, markHandAdded, setChecked, type ListItem, type Section } from "../lists/repo.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { lineQuantity, needsMore, type QuantityPart } from "./quantity.js";

export interface Share {
  id: number;
  lineId: number | null;
  plannedDinnerId: number;
  dishId: number;
  quantity: number | null;
  unit: string | null;
}

interface ShareRow {
  id: number;
  list_item_id: number | null;
  planned_dinner_id: number;
  dish_id: number;
  quantity: number | null;
  unit: string | null;
}

interface DinnerRow {
  id: number;
  plan_id: number;
  date: string;
  dish_id: number | null;
}

const toShare = (r: ShareRow): Share => ({ id: r.id, lineId: r.list_item_id, plannedDinnerId: r.planned_dinner_id, dishId: r.dish_id, quantity: r.quantity, unit: r.unit });

/** The live Shares of a line (tombstones excluded). */
export function sharesOfLine(db: Database.Database, lineId: number): Share[] {
  return (db.prepare("SELECT * FROM shopping_share WHERE list_item_id = ? ORDER BY id").all(lineId) as ShareRow[]).map(toShare);
}

/** Every Share of a Planned Dinner, tombstones included. */
export function sharesOfDinner(db: Database.Database, plannedDinnerId: number): Share[] {
  return (db.prepare("SELECT * FROM shopping_share WHERE planned_dinner_id = ? ORDER BY id").all(plannedDinnerId) as ShareRow[]).map(toShare);
}

export function partsOf(shares: readonly Share[]): QuantityPart[] {
  return shares.flatMap((s) => (s.quantity === null ? [] : [{ quantity: s.quantity, unit: s.unit }]));
}

/** The line's quantity from its live Shares and its own free text. */
export function quantityOfLine(db: Database.Database, line: ListItem) {
  return lineQuantity(partsOf(sharesOfLine(db, line.id)), line.handAdded ? line.quantity : null);
}

/**
 * The empty-line rule for one line after its Shares changed: no Shares and not hand-added
 * means delete if unticked, keep as hand-added if ticked. A ticked line that now needs more
 * than before is un-ticked. `before` is the line's parts before the change.
 */
export function settleLine(db: Database.Database, lineId: number, before: readonly QuantityPart[]): void {
  const line = getItem(db, lineId);
  if (!line) return;
  const shares = sharesOfLine(db, lineId);
  if (shares.length === 0 && !line.handAdded) {
    if (line.checkedAt === null) db.prepare("DELETE FROM list_item WHERE id = ?").run(lineId);
    else markHandAdded(db, lineId, undefined);
    return;
  }
  if (line.checkedAt !== null && needsMore(before, partsOf(shares))) setChecked(db, lineId, null);
}

/** Withdraws a dinner's Shares (live and tombstone) and settles the lines they left. Returns the touched line ids. */
export function withdrawShares(db: Database.Database, plannedDinnerId: number, touched = new Map<number, QuantityPart[]>()): Map<number, QuantityPart[]> {
  for (const share of sharesOfDinner(db, plannedDinnerId)) {
    if (share.lineId !== null && !touched.has(share.lineId)) touched.set(share.lineId, partsOf(sharesOfLine(db, share.lineId)));
  }
  db.prepare("DELETE FROM shopping_share WHERE planned_dinner_id = ?").run(plannedDinnerId);
  db.prepare("DELETE FROM shopping_missing WHERE planned_dinner_id = ?").run(plannedDinnerId);
  return touched;
}

/**
 * Adds one Share per Ingredient for a Planned Dinner: finds or creates the line by name, with a
 * new line's section from `sectionFor`. Records the parts each touched line had before, for
 * `settleLine`. Does not settle; the caller settles once after every change of the update.
 */
export function addShares(
  db: Database.Database,
  dinner: { id: number; dishId: number },
  ingredients: readonly Ingredient[],
  sectionFor: (name: string) => Section,
  now: string,
  touched = new Map<number, QuantityPart[]>(),
): Map<number, QuantityPart[]> {
  const insert = db.prepare("INSERT INTO shopping_share (list_item_id, planned_dinner_id, dish_id, quantity, unit, added_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const ing of ingredients) {
    const name = ing.name.trim();
    if (!name) continue;
    let line = findItemByName(db, SHOPPING_LIST_ID, name);
    if (line) {
      if (!touched.has(line.id)) touched.set(line.id, partsOf(sharesOfLine(db, line.id)));
    } else {
      line = createItem(db, SHOPPING_LIST_ID, { name, section: sectionFor(name) }, now);
      touched.set(line.id, []);
    }
    insert.run(line.id, dinner.id, dinner.dishId, ing.quantity, ing.unit, now);
  }
  return touched;
}

export type ShoppingUpdateDeps = ResolveDeps;

export interface ShoppingUpdateResult {
  /** `Dish name: reason` for each dinner whose resolution degraded. */
  degradedReasons: string[];
  /** Planned Dinners with no Ingredients after this update. */
  missingDinnerIds: number[];
  /** How many dinners got new Shares. */
  added: number;
}

/** The plan's dinners with a Dish, in date order. */
function dinnersOfPlan(db: Database.Database, planId: number): DinnerRow[] {
  return db.prepare("SELECT id, plan_id, date, dish_id FROM planned_dinner WHERE plan_id = ? ORDER BY date").all(planId) as DinnerRow[];
}

/** Shares and missing marks whose Planned Dinner no longer exists, or whose dinner has another Dish now. */
function staleDinnerIds(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.planned_dinner_id AS id FROM shopping_share s LEFT JOIN planned_dinner pd ON pd.id = s.planned_dinner_id
       WHERE pd.id IS NULL OR pd.dish_id IS NULL OR pd.dish_id <> s.dish_id
       UNION
       SELECT m.planned_dinner_id AS id FROM shopping_missing m LEFT JOIN planned_dinner pd ON pd.id = m.planned_dinner_id
       WHERE pd.id IS NULL OR pd.dish_id IS NULL`,
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * The Plan Run's Shopping List update (Phase `shopping-list-update`) for one Weekly Plan, also
 * run after a Swap. Reconciles stale Shares across the whole list, then adds Shares for the
 * plan's dinners that have none. `freshDinnerIds` are re-resolved past their caches (Försök
 * igen); their old Shares, if any, are withdrawn first. Resolution failures degrade: the dinner
 * gets no Shares, is recorded as missing and named in `degradedReasons`.
 */
export async function updateShoppingList(deps: ShoppingUpdateDeps, planId: number, freshDinnerIds: ReadonlySet<number> = new Set()): Promise<ShoppingUpdateResult> {
  const { db } = deps;
  const now = (deps.now?.() ?? new Date()).toISOString();
  const touched = new Map<number, QuantityPart[]>();
  for (const id of staleDinnerIds(db)) withdrawShares(db, id, touched);
  for (const id of freshDinnerIds) withdrawShares(db, id, touched);

  const dinners = dinnersOfPlan(db, planId).filter((d) => d.dish_id !== null && sharesOfDinner(db, d.id).length === 0);
  const toResolve = dinners.flatMap((d) => {
    const dish = getDish(db, d.dish_id!);
    return dish ? [{ dinner: d, dish }] : [];
  });
  deps.onProgress?.({ phase: "ingredient-resolution" });
  const resolved: { dinner: DinnerRow; dish: NonNullable<ReturnType<typeof getDish>>; ingredients: Ingredient[] }[] = [];
  const degradedReasons: string[] = [];
  const missingDinnerIds: number[] = [];
  for (const [done, { dinner, dish }] of toResolve.entries()) {
    deps.onProgress?.({ phase: "ingredient-resolution", progress: { done, total: toResolve.length, dish: dish.name } });
    const result = await resolveIngredients(deps, dish, { fresh: freshDinnerIds.has(dinner.id) });
    if (result.source === "llm" && result.sourceUrl) db.prepare("UPDATE planned_dinner SET source_url = ? WHERE id = ?").run(result.sourceUrl, dinner.id);
    if (result.degradedReason) degradedReasons.push(`${dish.name}: ${result.degradedReason}`);
    if (result.ingredients.length === 0) missingDinnerIds.push(dinner.id);
    resolved.push({ dinner, dish, ingredients: result.ingredients });
  }

  deps.onProgress?.({ phase: "pantry-matching" });
  const newNames = [...new Set(resolved.flatMap((r) => r.ingredients.map((i) => i.name.trim())).filter((n) => n && !findItemByName(db, SHOPPING_LIST_ID, n)))];
  const matches = newNames.length ? await matchPantry(newNames, listPantryItems(db), deps.llm) : new Map();
  const sectionFor = (name: string): Section => (matches.get(name) ? "check_pantry" : "buy");

  deps.onProgress?.({ phase: "shopping-list-update" });
  const lastLineBefore = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM list_item").get() as { id: number }).id;
  db.transaction(() => {
    for (const { dinner, dish, ingredients } of resolved) {
      db.prepare("DELETE FROM shopping_missing WHERE planned_dinner_id = ?").run(dinner.id);
      if (ingredients.length === 0) db.prepare("INSERT OR IGNORE INTO shopping_missing (planned_dinner_id) VALUES (?)").run(dinner.id);
      else addShares(db, { id: dinner.id, dishId: dish.id }, ingredients, sectionFor, now, touched);
    }
    for (const [lineId, before] of touched) settleLine(db, lineId, before);
    // One Activity row for the update: how many new lines the planner wrote.
    const newLines = (db.prepare("SELECT COUNT(*) AS n FROM list_item WHERE list_id = ? AND id > ?").get(SHOPPING_LIST_ID, lastLineBefore) as { n: number }).n;
    if (newLines > 0) recordActivity(db, SHOPPING_LIST_ID, "planned", String(newLines), undefined, now);
  })();
  return { degradedReasons, missingDinnerIds, added: resolved.filter((r) => r.ingredients.length > 0).length };
}

/** The Planned Dinners recorded as missing Ingredients, with their Dish and date, oldest date first. */
export function listMissingDinners(db: Database.Database): { id: number; planId: number; date: string; dishId: number }[] {
  const rows = db
    .prepare(
      `SELECT pd.id, pd.plan_id, pd.date, pd.dish_id FROM shopping_missing m JOIN planned_dinner pd ON pd.id = m.planned_dinner_id
       WHERE pd.dish_id IS NOT NULL ORDER BY pd.date`,
    )
    .all() as { id: number; plan_id: number; date: string; dish_id: number }[];
  return rows.map((r) => ({ id: r.id, planId: r.plan_id, date: r.date, dishId: r.dish_id }));
}

/** The deterministic Pantry match for a hand-added line: Check pantry when a Pantry Item's name or alias equals it. */
export function handAddSection(db: Database.Database, name: string): Section {
  return pantryLookup(listPantryItems(db))(name) ? "check_pantry" : "buy";
}
