/**
 * One row per push attempt per sink, so the Shopping List view can show the latest result.
 * `buy_hash` fingerprints the Buy list sent, so the view can tell when the list changed since.
 */
export const SCHEMA_SINKS = `CREATE TABLE IF NOT EXISTS sink_push (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id   INTEGER NOT NULL REFERENCES weekly_plan(id) ON DELETE CASCADE,
  sink_id   TEXT NOT NULL,
  pushed_at TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  error     TEXT,
  detail    TEXT,
  buy_hash  TEXT
);`;
