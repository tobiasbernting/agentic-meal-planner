/**
 * One-time migration from the per-week Shopping List to the living list (ADR-0009, spec #120),
 * run through `runOnce` in src/db.ts. The latest built plan's rows become lines and Shares, its
 * Checked Off names become ticks, its Extra Items become hand-added lines and its Removed Lines
 * are skipped once; older weeks' edits are dropped. Then the five old tables go, and `sink_push`
 * loses its foreign key to the plan (a regenerated plan no longer erases the push history).
 * A fresh database has none of the old tables and passes straight through.
 */
import type Database from "better-sqlite3";
import { createItem, findItemByName, markHandAdded, setChecked, type Section } from "../lists/repo.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { SCHEMA_SINKS } from "../sinks/schema.js";
import { normaliseName } from "../text.js";

const OLD_TABLES = ["shopping_list_item", "shopping_list_missing", "shopping_checked", "shopping_removed", "shopping_extra"];

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function migrateToLivingShoppingList(db: Database.Database): void {
  if (tableExists(db, "shopping_list_item")) migrateRows(db);
  for (const table of OLD_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  dropSinkPushForeignKey(db);
}

function migrateRows(db: Database.Database): void {
  const now = new Date().toISOString();
  const latest = db
    .prepare("SELECT wp.id AS plan_id, wp.week_start FROM shopping_list_item sli JOIN weekly_plan wp ON wp.id = sli.plan_id ORDER BY wp.week_start DESC LIMIT 1")
    .get() as { plan_id: number; week_start: string } | undefined;
  if (!latest) return;
  const { plan_id: planId, week_start: weekStart } = latest;

  const dinnerByDish = new Map<number, number>();
  for (const d of db.prepare("SELECT id, dish_id FROM planned_dinner WHERE plan_id = ? AND dish_id IS NOT NULL ORDER BY date").all(planId) as { id: number; dish_id: number }[]) {
    if (!dinnerByDish.has(d.dish_id)) dinnerByDish.set(d.dish_id, d.id);
  }
  const names = (table: string) => new Set((db.prepare(`SELECT name FROM ${table} WHERE week_start = ?`).all(weekStart) as { name: string }[]).map((r) => r.name));
  const removed = tableExists(db, "shopping_removed") ? names("shopping_removed") : new Set<string>();
  const checked = tableExists(db, "shopping_checked") ? names("shopping_checked") : new Set<string>();

  const insertShare = db.prepare("INSERT INTO shopping_share (list_item_id, planned_dinner_id, dish_id, quantity, unit, added_at) VALUES (?, ?, ?, ?, ?, ?)");
  const rows = db
    .prepare("SELECT name, quantity, unit, section, source_dish_ids FROM shopping_list_item WHERE plan_id = ? ORDER BY position")
    .all(planId) as { name: string; quantity: string | null; unit: string | null; section: Section; source_dish_ids: string }[];
  for (const row of rows) {
    const key = normaliseName(row.name);
    if (removed.has(key) || findItemByName(db, SHOPPING_LIST_ID, row.name)) continue;
    const line = createItem(db, SHOPPING_LIST_ID, { name: row.name, section: row.section }, now);
    const dishIds = (JSON.parse(row.source_dish_ids) as number[]).filter((id) => dinnerByDish.has(id));
    const numeric = row.quantity !== null && Number.isFinite(Number(row.quantity)) ? Number(row.quantity) : null;
    dishIds.forEach((dishId, i) => insertShare.run(line.id, dinnerByDish.get(dishId), dishId, i === 0 ? numeric : null, i === 0 ? row.unit : null, now));
    if (checked.has(key)) setChecked(db, line.id, now);
  }

  if (tableExists(db, "shopping_extra")) {
    const extras = db.prepare("SELECT name, quantity FROM shopping_extra WHERE week_start = ? ORDER BY position, id").all(weekStart) as { name: string; quantity: string | null }[];
    for (const extra of extras) {
      const existing = findItemByName(db, SHOPPING_LIST_ID, extra.name);
      if (existing) markHandAdded(db, existing.id, extra.quantity);
      else createItem(db, SHOPPING_LIST_ID, { name: extra.name, quantity: extra.quantity, section: "buy", handAdded: true }, now);
    }
  }

  if (tableExists(db, "shopping_list_missing")) {
    const missing = db.prepare("SELECT dish_id FROM shopping_list_missing WHERE plan_id = ?").all(planId) as { dish_id: number }[];
    for (const { dish_id } of missing) {
      const dinnerId = dinnerByDish.get(dish_id);
      if (dinnerId !== undefined) db.prepare("INSERT OR IGNORE INTO shopping_missing (planned_dinner_id) VALUES (?)").run(dinnerId);
    }
  }
}

/** Rebuilds `sink_push` without its foreign key when an older database still has one. */
function dropSinkPushForeignKey(db: Database.Database): void {
  const keys = db.pragma("foreign_key_list(sink_push)") as unknown[];
  if (keys.length === 0) return;
  db.exec(`ALTER TABLE sink_push RENAME TO sink_push_old;
${SCHEMA_SINKS}
INSERT INTO sink_push (id, plan_id, sink_id, pushed_at, ok, error, detail, buy_hash)
  SELECT id, plan_id, sink_id, pushed_at, ok, error, detail, buy_hash FROM sink_push_old;
DROP TABLE sink_push_old;`);
}
