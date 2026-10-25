import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DB_FILENAME, openDatabase, readSetting } from "../db.js";
import { getShoppingList } from "./list.js";
import { listMissingDinners } from "./shares.js";

/** The schema as it was before spec #120: the per-week tables, and `sink_push` with its plan foreign key. */
const OLD_SCHEMA = `
CREATE TABLE dish (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, recipe_url TEXT, adaptation_notes TEXT, prep_time_minutes INTEGER, main_category TEXT, in_rotation INTEGER NOT NULL DEFAULT 1, preferred_days TEXT NOT NULL DEFAULT '', weekend_only INTEGER NOT NULL DEFAULT 0, suggested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE weekly_plan (id INTEGER PRIMARY KEY AUTOINCREMENT, week_start TEXT NOT NULL UNIQUE, generated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'generated', degraded_reasons TEXT NOT NULL DEFAULT '[]');
CREATE TABLE planned_dinner (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES weekly_plan(id) ON DELETE CASCADE, date TEXT NOT NULL, dish_id INTEGER REFERENCES dish(id) ON DELETE SET NULL, is_quick_day INTEGER NOT NULL DEFAULT 0, lunch_that_day TEXT, selection_rationale TEXT NOT NULL, source_url TEXT, UNIQUE (plan_id, date));
CREATE TABLE shopping_list_item (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES weekly_plan(id) ON DELETE CASCADE, position INTEGER NOT NULL, name TEXT NOT NULL, quantity TEXT, unit TEXT, section TEXT NOT NULL, source_dish_ids TEXT NOT NULL DEFAULT '[]');
CREATE TABLE shopping_list_missing (plan_id INTEGER NOT NULL, dish_id INTEGER NOT NULL, PRIMARY KEY (plan_id, dish_id));
CREATE TABLE shopping_checked (week_start TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (week_start, name));
CREATE TABLE shopping_removed (week_start TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (week_start, name));
CREATE TABLE shopping_extra (id INTEGER PRIMARY KEY AUTOINCREMENT, week_start TEXT NOT NULL, name TEXT NOT NULL, quantity TEXT, position INTEGER NOT NULL);
CREATE TABLE sink_push (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES weekly_plan(id) ON DELETE CASCADE, sink_id TEXT NOT NULL, pushed_at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, detail TEXT, buy_hash TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('migrated.extraction-cache-language-71', 'x'), ('migrated.extraction-cache-quantities-86', 'x');
`;

/** Two built weeks: week 42 (old) and week 43 (latest), with ticks, an Extra Item, a Removed Line and a missing Dish on each. */
function seedOldDatabase(dataDir: string): { pasta: number; gratin: number; soup: number } {
  const db = new Database(join(dataDir, DB_FILENAME));
  db.exec(OLD_SCHEMA);
  const dish = (name: string) => Number(db.prepare("INSERT INTO dish (name) VALUES (?)").run(name).lastInsertRowid);
  const pasta = dish("Pasta");
  const gratin = dish("Gratäng");
  const soup = dish("Soppa");
  const plan = (week: string) => Number(db.prepare("INSERT INTO weekly_plan (week_start, generated_at) VALUES (?, ?)").run(week, "2026-10-11T18:00:00Z").lastInsertRowid);
  const dinner = (planId: number, date: string, dishId: number) => db.prepare("INSERT INTO planned_dinner (plan_id, date, dish_id, selection_rationale) VALUES (?, ?, ?, 'r')").run(planId, date, dishId);
  const item = (planId: number, pos: number, name: string, q: string | null, unit: string | null, section: string, dishes: number[]) =>
    db.prepare("INSERT INTO shopping_list_item (plan_id, position, name, quantity, unit, section, source_dish_ids) VALUES (?, ?, ?, ?, ?, ?, ?)").run(planId, pos, name, q, unit, section, JSON.stringify(dishes));

  const old = plan("2026-10-12");
  dinner(old, "2026-10-12", pasta);
  item(old, 0, "pasta", "400", "g", "buy", [pasta]);
  db.prepare("INSERT INTO shopping_checked (week_start, name) VALUES ('2026-10-12', 'pasta')").run();
  db.prepare("INSERT INTO shopping_extra (week_start, name, quantity, position) VALUES ('2026-10-12', 'old batteries', NULL, 0)").run();

  const latest = plan("2026-10-19");
  dinner(latest, "2026-10-19", pasta);
  dinner(latest, "2026-10-20", gratin);
  dinner(latest, "2026-10-21", soup);
  item(latest, 0, "pasta", "500", "g", "buy", [pasta, gratin]);
  item(latest, 1, "ost", null, null, "buy", [gratin]);
  item(latest, 2, "mjölk", "2", "dl", "check_pantry", [pasta]);
  db.prepare("INSERT INTO shopping_checked (week_start, name) VALUES ('2026-10-19', 'ost')").run();
  db.prepare("INSERT INTO shopping_removed (week_start, name) VALUES ('2026-10-19', 'mjölk')").run();
  db.prepare("INSERT INTO shopping_extra (week_start, name, quantity, position) VALUES ('2026-10-19', 'batteries', '2 pack', 0)").run();
  db.prepare("INSERT INTO shopping_list_missing (plan_id, dish_id) VALUES (?, ?)").run(latest, soup);
  db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok) VALUES (?, 'webhook', '2026-10-18T18:05:00Z', 1)").run(latest);
  db.close();
  return { pasta, gratin, soup };
}

describe("migration to the living Shopping List", () => {
  it("carries the latest week's lines, ticks and Extra Items over once, skips its Removed Lines and drops the old tables", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-migrate-"));
    const { pasta, gratin, soup } = seedOldDatabase(dataDir);

    const db = openDatabase(dataDir);

    const { buy, checkPantry } = getShoppingList(db);
    expect(buy.map((l) => [l.quantity, l.unit, l.name, l.checked, l.handAdded])).toEqual([
      ["500", "g", "pasta", false, false],
      ["2 pack", null, "batteries", false, true],
      [null, null, "ost", true, false],
    ]);
    expect(buy[0]!.sourceDishIds).toEqual([pasta, gratin]);
    expect(buy[0]!.dinners.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(checkPantry).toEqual([]);
    expect(listMissingDinners(db).map((d) => d.dishId)).toEqual([soup]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'shopping_%' ORDER BY name").all()).toEqual([{ name: "shopping_missing" }, { name: "shopping_share" }]);
    expect(db.pragma("foreign_key_list(sink_push)")).toEqual([]);
    expect(db.prepare("SELECT plan_id, sink_id FROM sink_push").all()).toEqual([{ plan_id: 2, sink_id: "webhook" }]);
    expect(readSetting(db, "migrated.living-shopping-list-120")).toBeDefined();

    // Opening again does not migrate twice.
    db.close();
    const again = openDatabase(dataDir);
    expect(getShoppingList(again).buy).toHaveLength(3);
  });

  it("passes straight through on a fresh database", () => {
    const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-migrate-fresh-")));
    expect(getShoppingList(db)).toEqual({ buy: [], checkPantry: [] });
    expect(db.prepare("SELECT id, kind FROM list").all()).toEqual([{ id: 1, kind: "shopping" }]);
  });
});
