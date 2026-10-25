/**
 * Done records of repeating Todos (ADR-0010): ticking a repeating Todo advances its Due and
 * writes one row here instead of striking the line. `member_name` keeps the attribution when the
 * Member is later deleted. The Todo columns themselves are added to `list_item` in src/db.ts.
 */
export const SCHEMA_TODOS = `CREATE TABLE IF NOT EXISTS list_item_done (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  list_item_id INTEGER NOT NULL REFERENCES list_item(id) ON DELETE CASCADE,
  done_at      TEXT NOT NULL,
  member_id    INTEGER,
  member_name  TEXT
);`;
