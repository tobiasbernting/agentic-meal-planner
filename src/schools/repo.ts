import type Database from "better-sqlite3";

export interface School {
  id: number;
  name: string;
  url: string;
  /** School Plugin id; null means the LLM fallback (ADR-0004). Not user-edited yet. */
  pluginId: string | null;
  /** false = paused: the School is kept but never scraped. */
  active: boolean;
}

export interface SchoolInput {
  name: string;
  url: string;
}

interface SchoolRow {
  id: number;
  name: string;
  url: string;
  plugin_id: string | null;
  active: number;
}

const SELECT = "SELECT id, name, url, plugin_id, active FROM school";

function toSchool(row: SchoolRow): School {
  return { id: row.id, name: row.name, url: row.url, pluginId: row.plugin_id, active: row.active === 1 };
}

export function createSchool(db: Database.Database, input: SchoolInput): School {
  const result = db.prepare("INSERT INTO school (name, url) VALUES (?, ?)").run(input.name, input.url);
  return getSchool(db, Number(result.lastInsertRowid))!;
}

export function getSchool(db: Database.Database, id: number): School | undefined {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as SchoolRow | undefined;
  return row ? toSchool(row) : undefined;
}

export function listSchools(db: Database.Database): School[] {
  return (db.prepare(`${SELECT} ORDER BY id`).all() as SchoolRow[]).map(toSchool);
}

/** The Schools lunch ingest should scrape: paused ones are excluded. */
export function listActiveSchools(db: Database.Database): School[] {
  return (db.prepare(`${SELECT} WHERE active = 1 ORDER BY id`).all() as SchoolRow[]).map(toSchool);
}

export function updateSchool(db: Database.Database, id: number, input: SchoolInput): void {
  db.prepare("UPDATE school SET name = ?, url = ? WHERE id = ?").run(input.name, input.url, id);
}

export function deleteSchool(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM school WHERE id = ?").run(id);
}

/** Pause (`false`) or resume (`true`) a School. A paused School is kept, not deleted. */
export function setSchoolActive(db: Database.Database, id: number, active: boolean): void {
  db.prepare("UPDATE school SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}
