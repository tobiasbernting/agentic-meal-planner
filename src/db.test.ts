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
