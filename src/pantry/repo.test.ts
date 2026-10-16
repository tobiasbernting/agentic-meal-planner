import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createPantryItem, deletePantryItem, getPantryItem, listPantryItems, updatePantryItem } from "./repo.js";

const dbs: Database.Database[] = [];

function freshDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-pantry-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

describe("Pantry Item repository", () => {
  it("saves a Pantry Item with its aliases and lists it", () => {
    const db = freshDb();

    const milk = createPantryItem(db, { name: "milk", aliases: ["mjölk", "whole milk"] });

    expect(milk).toEqual({ id: 1, name: "milk", aliases: ["mjölk", "whole milk"] });
    expect(listPantryItems(db)).toEqual([milk]);
    expect(getPantryItem(db, milk.id)).toEqual(milk);
  });

  it("stores an item without aliases as an empty list", () => {
    const db = freshDb();

    const flour = createPantryItem(db, { name: "flour", aliases: [] });

    expect(getPantryItem(db, flour.id)).toEqual({ id: flour.id, name: "flour", aliases: [] });
  });

  it("edits name and aliases, and removes an item", () => {
    const db = freshDb();
    const milk = createPantryItem(db, { name: "milk", aliases: ["mjölk"] });
    createPantryItem(db, { name: "flour", aliases: [] });

    updatePantryItem(db, milk.id, { name: "oat milk", aliases: ["havremjölk", "oatly"] });
    const edited = getPantryItem(db, milk.id);
    deletePantryItem(db, milk.id);

    expect(edited).toEqual({ id: milk.id, name: "oat milk", aliases: ["havremjölk", "oatly"] });
    expect(getPantryItem(db, milk.id)).toBeUndefined();
    expect(listPantryItems(db).map((p) => p.name)).toEqual(["flour"]);
  });
});
