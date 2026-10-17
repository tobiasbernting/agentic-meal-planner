/**
 * Shopping List rows (DESIGN.md `shopping_list_item`): one per aggregated Ingredient of a
 * Weekly Plan, in exactly one section. `source_dish_ids` is a JSON array of Dish ids since
 * a merged line can come from several Planned Dinners. Rebuilding replaces the plan's rows.
 *
 * The household's own edits (ADR-0007) live beside them, keyed by week start and normalised
 * ingredient name so a rebuild never touches them: Checked Off lines, Removed Lines, and Extra
 * Items (name, optional free-text quantity, position).
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
);
CREATE TABLE IF NOT EXISTS shopping_checked (
  week_start TEXT NOT NULL,
  name       TEXT NOT NULL,
  PRIMARY KEY (week_start, name)
);
CREATE TABLE IF NOT EXISTS shopping_removed (
  week_start TEXT NOT NULL,
  name       TEXT NOT NULL,
  PRIMARY KEY (week_start, name)
);
CREATE TABLE IF NOT EXISTS shopping_extra (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  name       TEXT NOT NULL,
  quantity   TEXT,
  position   INTEGER NOT NULL
);`;
