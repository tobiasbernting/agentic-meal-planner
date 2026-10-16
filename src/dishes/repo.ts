import type Database from "better-sqlite3";
import type { MainCategory } from "./categories.js";

/** Weekday keys used for Preferred Days (GLOSSARY). Stored as a JSON array of these keys. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === "string" && (WEEKDAYS as readonly string[]).includes(value);
}

/** A manual Ingredient line (GLOSSARY: Ingredient). */
export interface Ingredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface Dish {
  id: number;
  name: string;
  recipeUrl: string | null;
  adaptationNotes: string | null;
  prepTimeMinutes: number | null;
  mainCategory: MainCategory | null;
  /** True = Favorite Dish (GLOSSARY): eligible for the Weekly Plan. */
  inRotation: boolean;
  /** Preferred Days: soft preference. */
  preferredDays: Weekday[];
  /** Weekend Dish: hard rule, only Saturday or Sunday. */
  weekendOnly: boolean;
  ingredients: Ingredient[];
}

/** Everything but `id`; omitted optionals default to null / empty, `inRotation` to true (FR-1a). */
export type DishInput = Pick<Dish, "name"> & Partial<Omit<Dish, "id" | "name">>;

interface DishRow {
  id: number;
  name: string;
  recipe_url: string | null;
  adaptation_notes: string | null;
  prep_time_minutes: number | null;
  main_category: string | null;
  in_rotation: number;
  preferred_days: string;
  weekend_only: number;
}

interface IngredientRow {
  dish_id: number;
  name: string;
  quantity: number | null;
  unit: string | null;
}

function withDefaults(input: DishInput): Omit<Dish, "id"> {
  return {
    name: input.name,
    recipeUrl: input.recipeUrl ?? null,
    adaptationNotes: input.adaptationNotes ?? null,
    prepTimeMinutes: input.prepTimeMinutes ?? null,
    mainCategory: input.mainCategory ?? null,
    inRotation: input.inRotation ?? true,
    preferredDays: input.preferredDays ?? [],
    weekendOnly: input.weekendOnly ?? false,
    ingredients: input.ingredients ?? [],
  };
}

function toDish(row: DishRow, ingredients: Ingredient[]): Dish {
  return {
    id: row.id,
    name: row.name,
    recipeUrl: row.recipe_url,
    adaptationNotes: row.adaptation_notes,
    prepTimeMinutes: row.prep_time_minutes,
    mainCategory: row.main_category as MainCategory | null,
    inRotation: row.in_rotation === 1,
    preferredDays: JSON.parse(row.preferred_days) as Weekday[],
    weekendOnly: row.weekend_only === 1,
    ingredients,
  };
}

function toIngredient(row: IngredientRow): Ingredient {
  return { name: row.name, quantity: row.quantity, unit: row.unit };
}

function replaceIngredients(db: Database.Database, dishId: number, ingredients: Ingredient[]): void {
  db.prepare("DELETE FROM dish_ingredient WHERE dish_id = ?").run(dishId);
  const insert = db.prepare(
    "INSERT INTO dish_ingredient (dish_id, position, name, quantity, unit) VALUES (?, ?, ?, ?, ?)",
  );
  ingredients.forEach((ing, position) => insert.run(dishId, position, ing.name, ing.quantity, ing.unit));
}

export function createDish(db: Database.Database, input: DishInput): number {
  const dish = withDefaults(input);
  return db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO dish (name, recipe_url, adaptation_notes, prep_time_minutes, main_category,
                           in_rotation, preferred_days, weekend_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dish.name,
        dish.recipeUrl,
        dish.adaptationNotes,
        dish.prepTimeMinutes,
        dish.mainCategory,
        dish.inRotation ? 1 : 0,
        JSON.stringify(dish.preferredDays),
        dish.weekendOnly ? 1 : 0,
      );
    const id = Number(result.lastInsertRowid);
    replaceIngredients(db, id, dish.ingredients);
    return id;
  })();
}

export function updateDish(db: Database.Database, id: number, input: DishInput): boolean {
  const dish = withDefaults(input);
  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE dish SET name = ?, recipe_url = ?, adaptation_notes = ?, prep_time_minutes = ?,
                         main_category = ?, in_rotation = ?, preferred_days = ?, weekend_only = ?
         WHERE id = ?`,
      )
      .run(
        dish.name,
        dish.recipeUrl,
        dish.adaptationNotes,
        dish.prepTimeMinutes,
        dish.mainCategory,
        dish.inRotation ? 1 : 0,
        JSON.stringify(dish.preferredDays),
        dish.weekendOnly ? 1 : 0,
        id,
      );
    if (result.changes === 0) return false;
    replaceIngredients(db, id, dish.ingredients);
    return true;
  })();
}

export function getDish(db: Database.Database, id: number): Dish | undefined {
  const row = db.prepare("SELECT * FROM dish WHERE id = ?").get(id) as DishRow | undefined;
  if (!row) return undefined;
  const ingredients = (
    db.prepare("SELECT * FROM dish_ingredient WHERE dish_id = ? ORDER BY position").all(id) as IngredientRow[]
  ).map(toIngredient);
  return toDish(row, ingredients);
}

/** All dishes, in rotation or not, ordered by name. */
export function listDishes(db: Database.Database): Dish[] {
  const rows = db.prepare("SELECT * FROM dish ORDER BY name COLLATE NOCASE, id").all() as DishRow[];
  const ingredientRows = db
    .prepare("SELECT * FROM dish_ingredient ORDER BY dish_id, position")
    .all() as IngredientRow[];
  const byDish = new Map<number, Ingredient[]>();
  for (const row of ingredientRows) {
    const list = byDish.get(row.dish_id) ?? [];
    list.push(toIngredient(row));
    byDish.set(row.dish_id, list);
  }
  return rows.map((row) => toDish(row, byDish.get(row.id) ?? []));
}

export function deleteDish(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM dish WHERE id = ?").run(id).changes > 0;
}
