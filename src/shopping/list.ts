/**
 * The read side of the living Shopping List (ADR-0009): its lines in two sections, each with
 * the quantity its Shares add up to, the Planned Dinners it is for, and its tick. Checked Off
 * lines sort after the open ones within their section. Sinks and the page both read from here.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { listItems, type ListItem } from "../lists/repo.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { normaliseName } from "../text.js";
import { lineQuantity } from "./quantity.js";
import { partsOf, type Share } from "./shares.js";

/** One Planned Dinner a line is for: the Dish and its date (`date` null when the dinner is gone). */
export interface Provenance {
  dishId: number;
  date: string | null;
}

/** One line as the Shopping page and the sinks see it. */
export interface ShoppingLine {
  id: number;
  name: string;
  quantity: string | null;
  unit: string | null;
  sourceDishIds: number[];
  /** The dinners this line is for, by date. Empty for a hand-added line with no Shares. */
  dinners: Provenance[];
  checked: boolean;
  checkedAt: string | null;
  checkedBy: string | null;
  handAdded: boolean;
}

/** The line fields a sink receives: no tick, no id. */
export interface PushedItem {
  name: string;
  quantity: string | null;
  unit: string | null;
  sourceDishIds: number[];
}

export interface StoredShoppingList {
  buy: ShoppingLine[];
  checkPantry: ShoppingLine[];
}

interface ShareWithDate extends Share {
  date: string | null;
}

function sharesByLine(db: Database.Database): Map<number, ShareWithDate[]> {
  const rows = db
    .prepare(
      `SELECT s.id, s.list_item_id, s.planned_dinner_id, s.dish_id, s.quantity, s.unit, pd.date
       FROM shopping_share s LEFT JOIN planned_dinner pd ON pd.id = s.planned_dinner_id
       WHERE s.list_item_id IS NOT NULL ORDER BY pd.date, s.id`,
    )
    .all() as { id: number; list_item_id: number; planned_dinner_id: number; dish_id: number; quantity: number | null; unit: string | null; date: string | null }[];
  const byLine = new Map<number, ShareWithDate[]>();
  for (const r of rows) {
    const share: ShareWithDate = { id: r.id, lineId: r.list_item_id, plannedDinnerId: r.planned_dinner_id, dishId: r.dish_id, quantity: r.quantity, unit: r.unit, date: r.date };
    const list = byLine.get(r.list_item_id);
    if (list) list.push(share);
    else byLine.set(r.list_item_id, [share]);
  }
  return byLine;
}

function toLine(item: ListItem, shares: ShareWithDate[]): ShoppingLine {
  const { quantity, unit } = lineQuantity(partsOf(shares), item.handAdded ? item.quantity : null);
  const sourceDishIds = [...new Set(shares.map((s) => s.dishId))];
  return {
    id: item.id,
    name: item.name,
    quantity,
    unit,
    sourceDishIds,
    dinners: shares.map((s) => ({ dishId: s.dishId, date: s.date })),
    checked: item.checkedAt !== null,
    checkedAt: item.checkedAt,
    checkedBy: item.checkedBy,
    handAdded: item.handAdded,
  };
}

/** Unchecked lines first, then checked, each group in stored order. */
function checkedLast(lines: ShoppingLine[]): ShoppingLine[] {
  return [...lines.filter((l) => !l.checked), ...lines.filter((l) => l.checked)];
}

export function getShoppingList(db: Database.Database): StoredShoppingList {
  const shares = sharesByLine(db);
  const lines = listItems(db, SHOPPING_LIST_ID).map((item) => toLine(item, shares.get(item.id) ?? []));
  const section = (s: ListItem["section"]) => listItems(db, SHOPPING_LIST_ID).filter((i) => i.section === s).map((i) => i.id);
  const buyIds = new Set(section("buy"));
  return {
    buy: checkedLast(lines.filter((l) => buyIds.has(l.id))),
    checkPantry: checkedLast(lines.filter((l) => !buyIds.has(l.id))),
  };
}

/** The line as a sink receives it. */
export function pushedItem({ name, quantity, unit, sourceDishIds }: ShoppingLine): PushedItem {
  return { name, quantity, unit, sourceDishIds };
}

/**
 * A stable fingerprint of what a push sends, recorded with each push so the view can tell the
 * list changed since. Hashed in normalised-name order, so a reorder never changes it; only a
 * line's content or presence does.
 */
export function buyFingerprint(buy: readonly ShoppingLine[]): string {
  const keyed = buy.map((line) => [normaliseName(line.name), pushedItem(line)] as const);
  const sorted = keyed.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
