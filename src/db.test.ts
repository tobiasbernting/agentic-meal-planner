import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DB_FILENAME, openDatabase, readSetting } from "./db.js";

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "mp-db-"));
}

describe("openDatabase", () => {
  it("creates the SQLite file inside the data directory", () => {
    const dataDir = tempDataDir();

    const db = openDatabase(dataDir);
    db.close();

    expect(existsSync(join(dataDir, DB_FILENAME))).toBe(true);
  });

  it("keeps its data after the database is closed and reopened", () => {
    const dataDir = tempDataDir();

    const first = openDatabase(dataDir);
    const createdAt = readSetting(first, "created_at");
    first.close();

    const second = openDatabase(dataDir);
    const reopened = readSetting(second, "created_at");
    second.close();

    expect(createdAt).toBeDefined();
    expect(reopened).toBe(createdAt);
  });

  it("adds the preparation_note column to an old dish_ingredient table", () => {
    const dataDir = tempDataDir();
    openDatabase(dataDir).close();
    const old = new Database(join(dataDir, DB_FILENAME));
    old.exec("ALTER TABLE dish_ingredient DROP COLUMN preparation_note");
    old.close();

    const db = openDatabase(dataDir);
    const columns = (db.pragma("table_info(dish_ingredient)") as { name: string }[]).map((c) => c.name);
    db.close();

    expect(columns).toContain("preparation_note");
  });

  it("rebuilds a pre-language extraction cache empty, keyed by language, once", () => {
    const dataDir = tempDataDir();
    const old = new Database(join(dataDir, DB_FILENAME));
    old.exec(`CREATE TABLE recipe_extraction (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, content_hash TEXT NOT NULL,
      adaptation_notes TEXT NOT NULL DEFAULT '', ingredients_json TEXT NOT NULL, extracted_at TEXT NOT NULL,
      UNIQUE (url, content_hash, adaptation_notes));
    CREATE TABLE found_recipe (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dish_name TEXT NOT NULL, adaptation_notes TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL, ingredients_json TEXT NOT NULL, found_at TEXT NOT NULL,
      UNIQUE (dish_name, adaptation_notes));
    INSERT INTO recipe_extraction (url, content_hash, ingredients_json, extracted_at) VALUES ('u', 'h', '[]', 'now');
    INSERT INTO found_recipe (dish_name, url, ingredients_json, found_at) VALUES ('d', 'u', '[]', 'now');`);
    old.close();

    const first = openDatabase(dataDir);
    const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const afterUpgrade = [count(first, "recipe_extraction"), count(first, "found_recipe")];
    first.exec(`INSERT INTO recipe_extraction (url, content_hash, language, ingredients_json, extracted_at) VALUES ('u', 'h', 'sv', '[]', 'now');
      INSERT INTO recipe_extraction (url, content_hash, language, ingredients_json, extracted_at) VALUES ('u', 'h', 'en', '[]', 'now');`);
    first.close();
    const second = openDatabase(dataDir);
    const afterReopen = count(second, "recipe_extraction");
    second.close();

    expect(afterUpgrade).toEqual([0, 0]);
    expect(afterReopen).toBe(2);
  });

  it("adds the suggested column, default 0, to a pre-#51 dish table, and reopens cleanly", () => {
    const dataDir = tempDataDir();
    const old = new Database(join(dataDir, DB_FILENAME));
    old.exec(`CREATE TABLE dish (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT    NOT NULL,
      recipe_url        TEXT,
      adaptation_notes  TEXT,
      prep_time_minutes INTEGER,
      main_category     TEXT,
      in_rotation       INTEGER NOT NULL DEFAULT 1,
      preferred_days    TEXT    NOT NULL DEFAULT '[]',
      weekend_only      INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO dish (name) VALUES ('Tacos');`);
    old.close();

    openDatabase(dataDir).close();
    const db = openDatabase(dataDir);
    const column = (db.pragma("table_info(dish)") as { name: string; dflt_value: string | null }[]).find(
      (c) => c.name === "suggested",
    );
    const tacos = db.prepare("SELECT suggested FROM dish WHERE name = 'Tacos'").get() as { suggested: number };
    db.close();

    expect(column?.dflt_value).toBe("0");
    expect(tacos.suggested).toBe(0);
  });
});
