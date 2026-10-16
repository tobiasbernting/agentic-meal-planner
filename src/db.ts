import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "meal-planner.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', datetime('now'));
  `);
  return db;
}
