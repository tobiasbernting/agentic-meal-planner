/**
 * The household's edits to one week's Shopping List (ADR-0007): Checked Off lines, Removed
 * Lines and Extra Items. Keyed by week start and normalised ingredient name, never by plan or
 * row, so a rebuild (Build, Har alltid hemma, a Plan Run) leaves them in place. `applyEdits`
 * lays them over the stored sections: extras appended to Buy, removed lines filtered out into
 * their own list, the checked state joined onto every line and checked lines sorted last.
 */
import type Database from "better-sqlite3";
import { normaliseName } from "../text.js";
import type { AggregatedItem } from "./aggregate.js";
import type { ShoppingSections } from "./split.js";

/** One line as the Shopping page and the sinks see it. */
export interface ShoppingLine extends AggregatedItem {
  checked: boolean;
  /** Set on an Extra Item: the row to delete it by. Dish-derived lines have none. */
  extraId?: number;
}

export interface StoredShoppingList {
  buy: ShoppingLine[];
  checkPantry: ShoppingLine[];
  /** Removed Lines still present in the built list, restorable in this order. */
  removed: ShoppingLine[];
}

export function checkLine(db: Database.Database, weekStart: string, name: string): void {
  db.prepare("INSERT OR IGNORE INTO shopping_checked (week_start, name) VALUES (?, ?)").run(weekStart, normaliseName(name));
}

export function uncheckLine(db: Database.Database, weekStart: string, name: string): void {
  db.prepare("DELETE FROM shopping_checked WHERE week_start = ? AND name = ?").run(weekStart, normaliseName(name));
}

export interface ExtraItemInput {
  name: string;
  /** Free text ("2 pack"); no unit parsing. */
  quantity?: string | undefined;
}

export function addExtraItem(db: Database.Database, weekStart: string, { name, quantity }: ExtraItemInput): number {
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM shopping_extra WHERE week_start = ?").get(weekStart) as { next: number }).next;
  return Number(
    db.prepare("INSERT INTO shopping_extra (week_start, name, quantity, position) VALUES (?, ?, ?, ?)").run(weekStart, name.trim(), quantity?.trim() || null, position)
      .lastInsertRowid,
  );
}

/** Deletes outright: an Extra Item is never a Removed Line. Scoped to the week so a stale id cannot cross weeks. */
export function deleteExtraItem(db: Database.Database, weekStart: string, id: number): void {
  db.prepare("DELETE FROM shopping_extra WHERE week_start = ? AND id = ?").run(weekStart, id);
}

function extraLines(db: Database.Database, weekStart: string): ShoppingLine[] {
  const rows = db.prepare("SELECT id, name, quantity FROM shopping_extra WHERE week_start = ? ORDER BY position, id").all(weekStart) as { id: number; name: string; quantity: string | null }[];
  return rows.map((r) => ({ name: r.name, quantity: r.quantity, unit: null, sourceDishIds: [], checked: false, extraId: r.id }));
}

function checkedNames(db: Database.Database, weekStart: string): Set<string> {
  const rows = db.prepare("SELECT name FROM shopping_checked WHERE week_start = ?").all(weekStart) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Unchecked lines first, then checked, each group in its stored order. */
function checkedLast(lines: ShoppingLine[]): ShoppingLine[] {
  return [...lines.filter((l) => !l.checked), ...lines.filter((l) => l.checked)];
}

/** An unknown plan (`weekStart` undefined) has no edits: every line open, nothing removed. */
export function applyEdits(db: Database.Database, weekStart: string | undefined, { buy, checkPantry }: ShoppingSections): StoredShoppingList {
  const checked = weekStart ? checkedNames(db, weekStart) : new Set<string>();
  const extras = weekStart ? extraLines(db, weekStart) : [];
  const line = (item: ShoppingLine | AggregatedItem): ShoppingLine => ({ ...item, checked: checked.has(normaliseName(item.name)) });
  return {
    buy: checkedLast([...buy, ...extras].map(line)),
    checkPantry: checkedLast(checkPantry.map(line)),
    removed: [],
  };
}
