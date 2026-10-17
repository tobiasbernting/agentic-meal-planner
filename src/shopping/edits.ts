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
  const line = (item: AggregatedItem): ShoppingLine => ({ ...item, checked: checked.has(normaliseName(item.name)) });
  return {
    buy: checkedLast(buy.map(line)),
    checkPantry: checkedLast(checkPantry.map(line)),
    removed: [],
  };
}
