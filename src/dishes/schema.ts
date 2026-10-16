/** `dish` + `dish_ingredient` tables from docs/DESIGN.md. Idempotent DDL only. */
export const SCHEMA_DISHES = `
CREATE TABLE IF NOT EXISTS dish (
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
CREATE TABLE IF NOT EXISTS dish_ingredient (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_id  INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  quantity REAL,
  unit     TEXT
);
CREATE INDEX IF NOT EXISTS dish_ingredient_dish_id ON dish_ingredient(dish_id);
`;
