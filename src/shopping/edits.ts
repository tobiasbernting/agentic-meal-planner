/**
 * The household's edits to the living Shopping List (ADR-0009): tick and un-tick, hand-add,
 * Delete (one line) and Clear (every Checked Off line). They touch lines, never Shares, except
 * that Delete leaves the line's Shares as tombstones so the next Plan Run does not bring the
 * line back. Har alltid hemma (src/shopping/routes.ts) moves a line's section in place.
 */
import type Database from "better-sqlite3";
import { countCheckedItems, createItem, deleteCheckedItems, deleteItem, findItemByName, getItem, getList, markHandAdded, setChecked, setSection, type ListItem, type Section } from "../lists/repo.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { handAddSection } from "./shares.js";

/** The shopping-style List a line belongs to, or undefined for a Todo or an unknown id. */
export function shoppingLineList(db: Database.Database, id: number): number | undefined {
  const item = getItem(db, id);
  return item && getList(db, item.listId)?.kind === "shopping" ? item.listId : undefined;
}

export function checkLine(db: Database.Database, id: number, now: string, by: string | null = null): boolean {
  return shoppingLineList(db, id) !== undefined ? setChecked(db, id, now, by) : false;
}

export function uncheckLine(db: Database.Database, id: number): boolean {
  return shoppingLineList(db, id) !== undefined ? setChecked(db, id, null) : false;
}

export interface HandAddInput {
  name: string;
  /** Free text ("2 pack"); no unit parsing. */
  quantity?: string | undefined;
}

/**
 * Adds a line by hand. A name already on the list is un-ticked and marked hand-added (its free
 * text replaced when given) instead of duplicated; a new name lands in Buy, or in Check pantry
 * when a Pantry Item's name or alias equals it.
 */
export function addLine(db: Database.Database, { name, quantity }: HandAddInput, now: string, listId = SHOPPING_LIST_ID): ListItem {
  const text = quantity?.trim() || null;
  const existing = findItemByName(db, listId, name);
  if (existing) {
    markHandAdded(db, existing.id, text ?? undefined);
    if (existing.checkedAt !== null) setChecked(db, existing.id, null);
    return getItem(db, existing.id)!;
  }
  // Only the Shopping List has sections; another shopping-style List is one plain list of lines.
  const section = listId === SHOPPING_LIST_ID ? handAddSection(db, name) : null;
  return createItem(db, listId, { name, quantity: text, section, handAdded: true }, now);
}

/** Delete: the line goes for good; on the Shopping List its Shares become tombstones (schema). */
export function deleteLine(db: Database.Database, id: number): boolean {
  return shoppingLineList(db, id) !== undefined ? deleteItem(db, id) : false;
}

/** Clear: every Checked Off line of the List (both sections on the Shopping List). Returns how many went. */
export function clearChecked(db: Database.Database, listId = SHOPPING_LIST_ID): number {
  return deleteCheckedItems(db, listId);
}

export function countChecked(db: Database.Database, listId = SHOPPING_LIST_ID): number {
  return countCheckedItems(db, listId);
}

/** Har alltid hemma and its Ångra: moves a Shopping List line between Buy and Check pantry in place. */
export function moveLine(db: Database.Database, id: number, section: Section): void {
  if (getItem(db, id)?.listId === SHOPPING_LIST_ID) setSection(db, id, section);
}
