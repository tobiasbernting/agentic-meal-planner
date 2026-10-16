/**
 * Shopping List rows (DESIGN.md `shopping_list_item`): one per aggregated Ingredient of a
 * Weekly Plan, in exactly one section. `source_dish_ids` is a JSON array of Dish ids since
 * a merged line can come from several Planned Dinners. Rebuilding replaces the plan's rows.
 */
export const SCHEMA_SHOPPING = `CREATE TABLE IF NOT EXISTS shopping_list_item (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id         INTEGER NOT NULL REFERENCES weekly_plan(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  name            TEXT NOT NULL,
  quantity        TEXT,
  unit            TEXT,
  section         TEXT NOT NULL CHECK (section IN ('buy', 'check_pantry')),
  source_dish_ids TEXT NOT NULL DEFAULT '[]'
);`;
