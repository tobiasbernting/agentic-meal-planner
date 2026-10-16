import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const DB_FILENAME = "meal-planner.db";

/**
 * Opens (creating if needed) the SQLite database under `dataDir` and applies the schema.
 * The `settings` key/value table is the one documented in docs/DESIGN.md; `created_at`
 * is seeded on first open so persistence across restarts is observable.
 */
export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, DB_FILENAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO settings (key, value) VALUES ('created_at', datetime('now'));
  `);
  return db;
}

export function readSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
