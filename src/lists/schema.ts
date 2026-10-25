/**
 * Household Lists (ADR-0010) and the living Shopping List (ADR-0009) share one shape: a `list`
 * holds `list_item` rows. The Shopping List is the `list` row with id 1 (kind `shopping`),
 * created here and never deleted; its lines are keyed by normalised Ingredient name
 * (`name_key`) and hold Shares (`shopping_share`), one per Planned Dinner that wants the
 * Ingredient. `planned_dinner_id` is a plain integer, not a foreign key: when a plan is
 * regenerated its dinners vanish, and the Shopping List update reconciles the orphaned Shares
 * itself (withdrawing them under the empty-line rule) instead of a cascade deleting them
 * silently. A Share whose line the household Deleted keeps a tombstone row with
 * `list_item_id` null, so the next update sees its dinner as already pushed and does not
 * bring the line back.
 *
 * `shopping_missing` records the Planned Dinners whose Ingredient resolution yielded nothing
 * at the last update, so the page can name them and Försök igen can retry exactly those.
 *
 * Todo columns (due, member, repeat, notes) arrive with spec #121 via `addColumnIfMissing`.
 */
export const SHOPPING_LIST_ID = 1;

export const SCHEMA_LISTS = `CREATE TABLE IF NOT EXISTS list (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('shopping', 'todo')),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO list (id, name, kind, position, created_at) VALUES (${SHOPPING_LIST_ID}, 'Shopping List', 'shopping', 0, datetime('now'));
CREATE TABLE IF NOT EXISTS list_item (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id    INTEGER NOT NULL REFERENCES list(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  quantity   TEXT,
  unit       TEXT,
  section    TEXT CHECK (section IS NULL OR section IN ('buy', 'check_pantry')),
  hand_added INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  checked_by TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (list_id, name_key)
);
CREATE TABLE IF NOT EXISTS shopping_share (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  list_item_id      INTEGER REFERENCES list_item(id) ON DELETE SET NULL,
  planned_dinner_id INTEGER NOT NULL,
  dish_id           INTEGER NOT NULL,
  quantity          REAL,
  unit              TEXT,
  added_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shopping_share_line ON shopping_share(list_item_id);
CREATE INDEX IF NOT EXISTS shopping_share_dinner ON shopping_share(planned_dinner_id);
CREATE TABLE IF NOT EXISTS shopping_missing (
  planned_dinner_id INTEGER PRIMARY KEY
);`;
