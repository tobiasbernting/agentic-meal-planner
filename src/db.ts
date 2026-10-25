import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_DISHES } from "./dishes/schema.js";
import { SCHEMA_PLANNER } from "./planner/schema.js";
import { SCHEMA_SCHOOLS } from "./schools/schema.js";
import { SCHEMA_INGEST_OUTCOME, SCHEMA_LUNCH } from "./lunch/schema.js";
import { SCHEMA_PANTRY } from "./pantry/schema.js";
import { SCHEMA_INGREDIENTS } from "./ingredients/schema.js";
import { SCHEMA_SINKS } from "./sinks/schema.js";
import { SCHEMA_IDEMPOTENCY } from "./offline/idempotency.js";
import { SCHEMA_LISTS } from "./lists/schema.js";
import { SCHEMA_MEMBERS } from "./members/schema.js";
import { SCHEMA_TODOS } from "./lists/todos-schema.js";
import { migrateToLivingShoppingList } from "./shopping/migrate.js";

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
  SCHEMA_LUNCH,
  SCHEMA_INGEST_OUTCOME,
  SCHEMA_PANTRY,
  SCHEMA_PLANNER,
  SCHEMA_INGREDIENTS,
  SCHEMA_SINKS,
  SCHEMA_IDEMPOTENCY,
  SCHEMA_LISTS,
  SCHEMA_MEMBERS,
  SCHEMA_TODOS,
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
  addColumnIfMissing(db, "dish", "suggested", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "dish_ingredient", "preparation_note", "TEXT");
  addColumnIfMissing(db, "sink_push", "buy_hash", "TEXT");
  // Todo fields on list items (ADR-0010, spec #121).
  for (const [column, definition] of [["notes", "TEXT"], ["due_date", "TEXT"], ["due_time", "TEXT"], ["member_id", "INTEGER"], ["member_name", "TEXT"], ["added_by", "TEXT"], ["repeat", "TEXT"], ["reminded_at", "TEXT"]] as const) {
    addColumnIfMissing(db, "list_item", column, definition);
  }
  // The Shopping List became one living list with Shares (ADR-0009, spec #120): the per-week
  // tables migrate once and `sink_push` loses its plan foreign key.
  runOnce(db, "living-shopping-list-120", () => migrateToLivingShoppingList(db));
  // The extraction caches gained a language in their key (spec #71). They are caches, so the
  // old tables are dropped and rebuilt empty rather than migrated.
  runOnce(db, "extraction-cache-language-71", () =>
    db.exec(`DROP TABLE IF EXISTS recipe_extraction; DROP TABLE IF EXISTS found_recipe; ${SCHEMA_INGREDIENTS}`),
  );
  // The prompts now ask for quantities, so cached extractions without them are stale (spec #86).
  runOnce(db, "extraction-cache-quantities-86", () =>
    db.exec(`DROP TABLE IF EXISTS recipe_extraction; DROP TABLE IF EXISTS found_recipe; ${SCHEMA_INGREDIENTS}`),
  );
  return db;
}

/** Runs a one-time data migration, recorded in `settings` as `migrated.<name>`. */
function runOnce(db: Database.Database, name: string, migrate: () => void): void {
  const key = `migrated.${name}`;
  if (readSetting(db, key) !== undefined) return;
  db.transaction(() => {
    migrate();
    writeSetting(db, key, new Date().toISOString());
  })();
}

/** `CREATE TABLE IF NOT EXISTS` does not alter existing databases, so new columns need this. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
