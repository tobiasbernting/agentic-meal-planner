/** Pantry Item (GLOSSARY): restocked ad hoc, lands in "Check pantry". `aliases` is comma-separated TEXT (FR-12). */
export const SCHEMA_PANTRY = `CREATE TABLE IF NOT EXISTS pantry_item (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT ''
);`;
