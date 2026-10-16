import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createDish, deleteDish, getDish, listDishes, updateDish, type DishInput } from "./repo.js";

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
      ingredients: [{ name: "cod", quantity: 400, unit: "g" }],
    });
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
