/**
 * Members (ADR-0010): the people in the household, with a name and a colour. Data, not
 * accounts: no password, no login. `topic` is an optional ntfy topic for the Member's own
 * reminders (Daily Brief ticket). `colour` is one of the palette names in src/members/palette.ts.
 */
export const SCHEMA_MEMBERS = `CREATE TABLE IF NOT EXISTS member (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  colour   TEXT NOT NULL,
  topic    TEXT,
  position INTEGER NOT NULL DEFAULT 0
);`;
