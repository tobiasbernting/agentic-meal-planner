/** School (GLOSSARY): one menu URL each; `active` 0 = paused (kept, never scraped). */
export const SCHEMA_SCHOOLS = `CREATE TABLE IF NOT EXISTS school (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  url       TEXT NOT NULL,
  plugin_id TEXT,
  active    INTEGER NOT NULL DEFAULT 1
);`;
