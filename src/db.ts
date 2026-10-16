import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_DISHES } from "./dishes/schema.js";
import { SCHEMA_SCHOOLS } from "./schools/schema.js";
import { SCHEMA_PANTRY } from "./pantry/schema.js";

export const DB_FILENAME = "meal-planner.db";

/**
 * Schema fragments, applied in order on every open. Each feature module exports its own
 * `CREATE TABLE IF NOT EXISTS ...` string and registers it here with one line, so parallel
 * feature work only touches this array. Use idempotent DDL only.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   INSERT OR IGNORE INTO settings (key, value) VALUES ('created_at', datetime('now'));`,
  SCHEMA_DISHES,
  SCHEMA_SCHOOLS,
  SCHEMA_PANTRY,
];

/**
 * Opens (creating if needed) the SQLite database under `dataDir` and applies the schema.
 * The `settings` key/value table is the one documented in docs/DESIGN.md; `created_at`
 * is seeded on first open so persistence across restarts is observable.
 */
export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, DB_FILENAME));
  db.pragma("foreign_keys = ON");
  for (const sql of SCHEMA) db.exec(sql);
  return db;
}

export function readSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
