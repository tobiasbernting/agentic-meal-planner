import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createDish, deleteDish, getDish, listDishes, promoteDishToFavorite, updateDish, type DishInput } from "./repo.js";

const dbs: Database.Database[] = [];

function openTempDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-dishes-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

const fullTacos: DishInput = {
  name: "Tacos",
  recipeUrl: "https://example.com/tacos",
  adaptationNotes: "no chili - the kids",
  prepTimeMinutes: 25,
  mainCategory: "tacos",
  inRotation: true,
  preferredDays: ["fri", "sat"],
  weekendOnly: true,
  suggested: true,
  ingredients: [
    { name: "minced beef", quantity: 500, unit: "g" },
    { name: "tortillas", quantity: 8, unit: null },
    { name: "salsa", quantity: null, unit: null },
  ],
};

describe("dish repository", () => {
  it("reloads a dish saved with every field with the same values", () => {
    const db = openTempDb();

    const id = createDish(db, fullTacos);
    const dish = getDish(db, id);

    expect(dish).toEqual({ id, ...fullTacos });
  });

  it("starts a new dish in rotation when the flag is not given", () => {
    const db = openTempDb();

    const id = createDish(db, { name: "Pancakes" });

    expect(getDish(db, id)).toEqual({
      id,
      name: "Pancakes",
      recipeUrl: null,
      adaptationNotes: null,
      prepTimeMinutes: null,
      mainCategory: null,
      inRotation: true,
      preferredDays: [],
      weekendOnly: false,
      suggested: false,
      ingredients: [],
    });
  });

  it("replaces every field and the ingredient list on update", () => {
    const db = openTempDb();
    const id = createDish(db, fullTacos);

    const updated = updateDish(db, id, {
      name: "Fish tacos",
      mainCategory: "fish",
      inRotation: false,
      ingredients: [{ name: "cod", quantity: 400, unit: "g" }],
    });

    expect(updated).toBe(true);
    expect(getDish(db, id)).toEqual({
      id,
      name: "Fish tacos",
      recipeUrl: null,
      adaptationNotes: null,
      prepTimeMinutes: null,
      mainCategory: "fish",
      inRotation: false,
      preferredDays: [],
      weekendOnly: false,
      suggested: true, // not given on update, so kept
      ingredients: [{ name: "cod", quantity: 400, unit: "g" }],
    });
  });

  it("stores a Preparation Note per Ingredient and omits it when there is none", () => {
    const db = openTempDb();
    const id = createDish(db, {
      name: "Mos",
      ingredients: [
        { name: "mjölk", quantity: 2, unit: "dl", preparationNote: "till mos" },
        { name: "potatis", quantity: 1, unit: "kg" },
      ],
    });

    expect(getDish(db, id)!.ingredients).toEqual([
      { name: "mjölk", quantity: 2, unit: "dl", preparationNote: "till mos" },
      { name: "potatis", quantity: 1, unit: "kg" },
    ]);
  });

  it("reports false when updating or deleting an unknown dish", () => {
    const db = openTempDb();

    expect(updateDish(db, 999, { name: "Ghost" })).toBe(false);
    expect(deleteDish(db, 999)).toBe(false);
  });

  it("lists dishes by name and drops a deleted dish", () => {
    const db = openTempDb();
    const tacos = createDish(db, fullTacos);
    createDish(db, { name: "burgers" });
    createDish(db, { name: "Pancakes" });

    expect(deleteDish(db, tacos)).toBe(true);

    expect(listDishes(db).map((d) => d.name)).toEqual(["burgers", "Pancakes"]);
    expect(getDish(db, tacos)).toBeUndefined();
  });
});

describe("suggested flag", () => {
  it("round-trips a Suggested Dish through getDish and listDishes, defaulting to false", () => {
    const db = openTempDb();
    const id = createDish(db, { name: "Köttbullar", inRotation: false, suggested: true });
    const plain = createDish(db, { name: "Pasta" });

    expect(getDish(db, id)?.suggested).toBe(true);
    expect(getDish(db, plain)?.suggested).toBe(false);
    expect(listDishes(db).find((d) => d.id === id)?.suggested).toBe(true);
  });

  it("keeps the flag on update unless the input says otherwise", () => {
    const db = openTempDb();
    const id = createDish(db, { name: "Köttbullar", inRotation: false, suggested: true });

    updateDish(db, id, { name: "Köttbullar med potatis", inRotation: false });
    expect(getDish(db, id)?.suggested).toBe(true);

    updateDish(db, id, { name: "Köttbullar", suggested: false });
    expect(getDish(db, id)?.suggested).toBe(false);
  });

  it("promoteDishToFavorite puts the Dish in rotation and clears the flag", () => {
    const db = openTempDb();
    const id = createDish(db, { name: "Köttbullar", inRotation: false, suggested: true });

    expect(promoteDishToFavorite(db, id)).toBe(true);

    const dish = getDish(db, id)!;
    expect(dish.inRotation).toBe(true);
    expect(dish.suggested).toBe(false);
  });

  it("promoteDishToFavorite returns false for an unknown id", () => {
    expect(promoteDishToFavorite(openTempDb(), 999)).toBe(false);
  });

  it("adds the column to a database created before the flag existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-dishes-old-"));
    const old = new Database(join(dir, "meal-planner.db"));
    old.exec(`CREATE TABLE dish (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, recipe_url TEXT, adaptation_notes TEXT,
      prep_time_minutes INTEGER, main_category TEXT, in_rotation INTEGER NOT NULL DEFAULT 1,
      preferred_days TEXT NOT NULL DEFAULT '[]', weekend_only INTEGER NOT NULL DEFAULT 0);
      INSERT INTO dish (name) VALUES ('Old');`);
    old.close();

    const db = openDatabase(dir);
    dbs.push(db);
    expect(listDishes(db)[0]).toMatchObject({ name: "Old", suggested: false });
    openDatabase(dir).close();
  });
});
