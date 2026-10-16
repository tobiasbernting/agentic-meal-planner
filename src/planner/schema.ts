/** `weekly_plan` + `planned_dinner` tables from docs/DESIGN.md. Idempotent DDL only. */
export const SCHEMA_PLANNER = `
CREATE TABLE IF NOT EXISTS weekly_plan (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start       TEXT    NOT NULL UNIQUE,
  generated_at     TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'confirmed')),
  degraded_reasons TEXT    NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS planned_dinner (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id             INTEGER NOT NULL REFERENCES weekly_plan(id) ON DELETE CASCADE,
  date                TEXT    NOT NULL,
  dish_id             INTEGER REFERENCES dish(id) ON DELETE SET NULL,
  is_quick_day        INTEGER NOT NULL DEFAULT 0,
  lunch_that_day      TEXT,
  selection_rationale TEXT    NOT NULL,
  source_url          TEXT,
  UNIQUE (plan_id, date)
);
CREATE INDEX IF NOT EXISTS planned_dinner_dish_id ON planned_dinner(dish_id);
`;
