/**
 * Lunch Entry (GLOSSARY): what a School serves on one date. One row per School and date;
 * when a School publishes several dishes for a date, `raw_text` holds them joined by
 * newline. `main_category` is a key from src/dishes/categories.ts or NULL.
 */
export const SCHEMA_LUNCH = `CREATE TABLE IF NOT EXISTS lunch_entry (
  school_id       INTEGER NOT NULL REFERENCES school(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  raw_text        TEXT NOT NULL,
  normalized_name TEXT,
  main_category   TEXT,
  fetched_at      TEXT NOT NULL,
  UNIQUE (school_id, date)
);`;

/**
 * Ingest Outcome (GLOSSARY): the latest lunch ingest attempt for a School. One row per
 * School, replaced on every attempt.
 */
export const SCHEMA_INGEST_OUTCOME = `CREATE TABLE IF NOT EXISTS ingest_outcome (
  school_id   INTEGER PRIMARY KEY REFERENCES school(id) ON DELETE CASCADE,
  week_start  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('fetched', 'cached', 'no-data')),
  reason      TEXT,
  recorded_at TEXT NOT NULL
);`;
