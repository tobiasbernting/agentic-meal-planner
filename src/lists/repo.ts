/**
 * Storage for Lists and their items (ADR-0009, ADR-0010). Items are looked up by id and, within
 * a List, by `name_key` (`normaliseName`), which is how the Shopping List merges the same
 * Ingredient from several Planned Dinners into one line and how a hand-add finds an existing
 * line instead of duplicating it. Shares live in src/shopping/shares.ts.
 */
import type Database from "better-sqlite3";
import { normaliseName } from "../text.js";

export type ListKind = "shopping" | "todo";
export type Section = "buy" | "check_pantry";

export interface List {
  id: number;
  name: string;
  kind: ListKind;
  position: number;
}

export interface ListItem {
  id: number;
  listId: number;
  name: string;
  nameKey: string;
  /** A hand-added line's free-text quantity ("2 pack"); Dish-derived quantity comes from the Shares. */
  quantity: string | null;
  unit: string | null;
  section: Section | null;
  handAdded: boolean;
  checkedAt: string | null;
  checkedBy: string | null;
  position: number;
  createdAt: string;
}

interface ListRow {
  id: number;
  name: string;
  kind: ListKind;
  position: number;
}

interface ItemRow {
  id: number;
  list_id: number;
  name: string;
  name_key: string;
  quantity: string | null;
  unit: string | null;
  section: Section | null;
  hand_added: number;
  checked_at: string | null;
  checked_by: string | null;
  position: number;
  created_at: string;
}

const SELECT_ITEM = "SELECT id, list_id, name, name_key, quantity, unit, section, hand_added, checked_at, checked_by, position, created_at FROM list_item";

function toItem(r: ItemRow): ListItem {
  return {
    id: r.id,
    listId: r.list_id,
    name: r.name,
    nameKey: r.name_key,
    quantity: r.quantity,
    unit: r.unit,
    section: r.section,
    handAdded: r.hand_added === 1,
    checkedAt: r.checked_at,
    checkedBy: r.checked_by,
    position: r.position,
    createdAt: r.created_at,
  };
}

export function getList(db: Database.Database, id: number): List | undefined {
  const row = db.prepare("SELECT id, name, kind, position FROM list WHERE id = ?").get(id) as ListRow | undefined;
  return row ?? undefined;
}

export function listLists(db: Database.Database): List[] {
  return db.prepare("SELECT id, name, kind, position FROM list ORDER BY position, id").all() as ListRow[];
}

export function createList(db: Database.Database, name: string, kind: ListKind, createdAt: string): List {
  const position = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM list").get() as { next: number }).next;
  const result = db.prepare("INSERT INTO list (name, kind, position, created_at) VALUES (?, ?, ?, ?)").run(name.trim(), kind, position, createdAt);
  return getList(db, Number(result.lastInsertRowid))!;
}

export function renameList(db: Database.Database, id: number, name: string): boolean {
  return db.prepare("UPDATE list SET name = ? WHERE id = ?").run(name.trim(), id).changes > 0;
}

/** Swaps positions with the neighbour above or below; the Shopping List (id 1) stays first. */
export function moveList(db: Database.Database, id: number, direction: "up" | "down"): boolean {
  const lists = listLists(db).filter((l) => l.id !== 1);
  const index = lists.findIndex((l) => l.id === id);
  const other = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || other < 0 || other >= lists.length) return false;
  const a = lists[index]!;
  const b = lists[other]!;
  db.transaction(() => {
    db.prepare("UPDATE list SET position = ? WHERE id = ?").run(other + 1, a.id);
    db.prepare("UPDATE list SET position = ? WHERE id = ?").run(index + 1, b.id);
    // Normalise so positions stay 1..n after any history of gaps.
    lists.forEach((l, i) => {
      if (l.id !== a.id && l.id !== b.id) db.prepare("UPDATE list SET position = ? WHERE id = ?").run(i + 1, l.id);
    });
  })();
  return true;
}

/** Deletes a List and, by the schema, its items. The Shopping List (id 1) is refused. */
export function deleteList(db: Database.Database, id: number): boolean {
  if (id === 1) return false;
  return db.prepare("DELETE FROM list WHERE id = ?").run(id).changes > 0;
}

export function countOpenItems(db: Database.Database, listId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM list_item WHERE list_id = ? AND checked_at IS NULL").get(listId) as { n: number }).n;
}

/** The List's items in position order (insertion order unless moved). */
export function listItems(db: Database.Database, listId: number): ListItem[] {
  return (db.prepare(`${SELECT_ITEM} WHERE list_id = ? ORDER BY position, id`).all(listId) as ItemRow[]).map(toItem);
}

export function getItem(db: Database.Database, id: number): ListItem | undefined {
  const row = db.prepare(`${SELECT_ITEM} WHERE id = ?`).get(id) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

export function findItemByName(db: Database.Database, listId: number, name: string): ListItem | undefined {
  const row = db.prepare(`${SELECT_ITEM} WHERE list_id = ? AND name_key = ?`).get(listId, normaliseName(name)) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

export interface NewItem {
  name: string;
  quantity?: string | null;
  unit?: string | null;
  section?: Section | null;
  handAdded?: boolean;
}

/** Appends an item to the List. The caller checks `findItemByName` first; a duplicate key throws. */
export function createItem(db: Database.Database, listId: number, item: NewItem, createdAt: string): ListItem {
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM list_item WHERE list_id = ?").get(listId) as { next: number }).next;
  const result = db
    .prepare(
      `INSERT INTO list_item (list_id, name, name_key, quantity, unit, section, hand_added, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(listId, item.name.trim(), normaliseName(item.name), item.quantity ?? null, item.unit ?? null, item.section ?? null, item.handAdded ? 1 : 0, position, createdAt);
  return getItem(db, Number(result.lastInsertRowid))!;
}

/** Ticks (`checkedAt` set) or un-ticks (`checkedAt` null) a line; `checkedBy` names the device's Member when known. */
export function setChecked(db: Database.Database, id: number, checkedAt: string | null, checkedBy: string | null = null): boolean {
  return db.prepare("UPDATE list_item SET checked_at = ?, checked_by = ? WHERE id = ?").run(checkedAt, checkedAt ? checkedBy : null, id).changes > 0;
}

export function setSection(db: Database.Database, id: number, section: Section): void {
  db.prepare("UPDATE list_item SET section = ? WHERE id = ?").run(section, id);
}

/** Marks a line hand-added, keeping or replacing its free-text quantity. */
export function markHandAdded(db: Database.Database, id: number, quantity: string | null | undefined): void {
  if (quantity === undefined) db.prepare("UPDATE list_item SET hand_added = 1 WHERE id = ?").run(id);
  else db.prepare("UPDATE list_item SET hand_added = 1, quantity = ? WHERE id = ?").run(quantity, id);
}

/** Deletes the line. Its Shares keep tombstone rows (`list_item_id` set null by the schema). */
export function deleteItem(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM list_item WHERE id = ?").run(id).changes > 0;
}

/** Deletes every ticked line of the List; returns how many went. */
export function deleteCheckedItems(db: Database.Database, listId: number): number {
  return db.prepare("DELETE FROM list_item WHERE list_id = ? AND checked_at IS NOT NULL").run(listId).changes;
}

export function countCheckedItems(db: Database.Database, listId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM list_item WHERE list_id = ? AND checked_at IS NOT NULL").get(listId) as { n: number }).n;
}
