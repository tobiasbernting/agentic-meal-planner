/**
 * Activity and the re-add tray (ADR-0010). `activity` records who did what on a List: every
 * add, tick, un-tick, Delete and Clear, with the device Member's name kept as text so a deleted
 * Member's rows still read, and the Plan Run's Shopping List update as one summary row with no
 * Member. A record, not a lock. `cleared_recent` remembers the lines Clear and Delete took off a
 * shopping-style List, so "Nyligen" can offer them back with one tap. Both keep 30 days.
 */
import type Database from "better-sqlite3";
import { normaliseName } from "../text.js";

export const SCHEMA_ACTIVITY = `CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id     INTEGER NOT NULL REFERENCES list(id) ON DELETE CASCADE,
  item_name   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('added', 'ticked', 'unticked', 'deleted', 'cleared', 'planned')),
  member_id   INTEGER,
  member_name TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_list ON activity(list_id, at);
CREATE TABLE IF NOT EXISTS cleared_recent (
  list_id    INTEGER NOT NULL REFERENCES list(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  quantity   TEXT,
  cleared_at TEXT NOT NULL,
  PRIMARY KEY (list_id, name_key)
);`;

/** How long Activity and the re-add tray remember. */
export const KEEP_DAYS = 30;

/** At most this many chips in "Nyligen". */
export const TRAY_SIZE = 20;

/** `cleared` and `planned` carry a count of lines in `item_name`. */
export type ActivityAction = "added" | "ticked" | "unticked" | "deleted" | "cleared" | "planned";

export interface ActivityRow {
  id: number;
  listId: number;
  itemName: string;
  action: ActivityAction;
  memberName: string | null;
  at: string;
}

/** The device Member an edit is attributed to; undefined for an unattributed edit. */
export type Actor = { id: number; name: string } | undefined;

export function recordActivity(db: Database.Database, listId: number, action: ActivityAction, itemName: string, by: Actor, at: string): void {
  db.prepare("INSERT INTO activity (list_id, item_name, action, member_id, member_name, at) VALUES (?, ?, ?, ?, ?, ?)").run(listId, itemName, action, by?.id ?? null, by?.name ?? null, at);
}

function cutoff(now: string): string {
  return new Date(Date.parse(now) - KEEP_DAYS * 86_400_000).toISOString();
}

/** The List's Activity of the last 30 days, newest first. */
export function listActivity(db: Database.Database, listId: number, now: string): ActivityRow[] {
  const rows = db
    .prepare("SELECT id, list_id, item_name, action, member_name, at FROM activity WHERE list_id = ? AND at >= ? ORDER BY at DESC, id DESC")
    .all(listId, cutoff(now)) as { id: number; list_id: number; item_name: string; action: ActivityAction; member_name: string | null; at: string }[];
  return rows.map((r) => ({ id: r.id, listId: r.list_id, itemName: r.item_name, action: r.action, memberName: r.member_name, at: r.at }));
}

/** Remembers lines taken off a shopping-style List, newest replacing an older one of the same name. */
export function rememberCleared(db: Database.Database, listId: number, lines: { name: string; quantity: string | null }[], at: string): void {
  const upsert = db.prepare(
    `INSERT INTO cleared_recent (list_id, name, name_key, quantity, cleared_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(list_id, name_key) DO UPDATE SET name = excluded.name, quantity = excluded.quantity, cleared_at = excluded.cleared_at`,
  );
  for (const line of lines) upsert.run(listId, line.name, normaliseName(line.name), line.quantity, at);
}

export interface ClearedLine {
  name: string;
  quantity: string | null;
}

/** "Nyligen": the last 30 days' cleared lines not on the List now, most recent first, at most 20. */
export function listRecentlyCleared(db: Database.Database, listId: number, now: string): ClearedLine[] {
  return db
    .prepare(
      `SELECT name, quantity FROM cleared_recent c
       WHERE c.list_id = ? AND c.cleared_at >= ? AND NOT EXISTS (SELECT 1 FROM list_item i WHERE i.list_id = c.list_id AND i.name_key = c.name_key)
       ORDER BY c.cleared_at DESC, c.name LIMIT ?`,
    )
    .all(listId, cutoff(now), TRAY_SIZE) as ClearedLine[];
}

/** Deletes Activity and tray rows older than 30 days. Runs at startup and once a day. */
export function pruneActivity(db: Database.Database, now: string): void {
  const before = cutoff(now);
  db.prepare("DELETE FROM activity WHERE at < ?").run(before);
  db.prepare("DELETE FROM cleared_recent WHERE cleared_at < ?").run(before);
}
