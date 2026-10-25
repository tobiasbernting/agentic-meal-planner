/**
 * One row per push attempt per sink, so the Shopping List view can show the latest result.
 * `plan_id` is the Plan Run that triggered the push, null for a manual one; it is a plain
 * integer, so a regenerated plan leaves the push history in place.
 * `buy_hash` fingerprints the Buy list sent, so the view can tell when the list changed since.
 */
export const SCHEMA_SINKS = `CREATE TABLE IF NOT EXISTS sink_push (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id   INTEGER,
  sink_id   TEXT NOT NULL,
  pushed_at TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  error     TEXT,
  detail    TEXT,
  buy_hash  TEXT
);`;
