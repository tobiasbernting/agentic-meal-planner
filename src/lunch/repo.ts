import type Database from "better-sqlite3";
import { listActiveSchools, type School } from "../schools/repo.js";

/** A stored Lunch Entry (one per School and date). */
export interface StoredLunchEntry {
  schoolId: number;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** As published; several dishes on one date are joined by newline. */
  rawText: string;
  normalizedName: string | null;
  /** Main Category key or null when none could be determined. */
  mainCategory: string | null;
  /** ISO timestamp of the scrape that produced this row. */
  fetchedAt: string;
}

export interface LunchEntryInput {
  schoolId: number;
  date: string;
  rawText: string;
  normalizedName?: string | null;
  mainCategory?: string | null;
  fetchedAt: string;
}

/** One School's lunch on a date; `entry` is null when there is no lunch data (FR-5 notice). */
export interface SchoolLunch {
  school: School;
  entry: StoredLunchEntry | null;
}

interface Row {
  school_id: number;
  date: string;
  raw_text: string;
  normalized_name: string | null;
  main_category: string | null;
  fetched_at: string;
}

const SELECT = "SELECT school_id, date, raw_text, normalized_name, main_category, fetched_at FROM lunch_entry";

function toEntry(row: Row): StoredLunchEntry {
  return {
    schoolId: row.school_id,
    date: row.date,
    rawText: row.raw_text,
    normalizedName: row.normalized_name,
    mainCategory: row.main_category,
    fetchedAt: row.fetched_at,
  };
}

/** Inserts or replaces the Lunch Entry for `schoolId` + `date`. */
export function upsertLunchEntry(db: Database.Database, input: LunchEntryInput): void {
  db.prepare(
    `INSERT INTO lunch_entry (school_id, date, raw_text, normalized_name, main_category, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(school_id, date) DO UPDATE SET
       raw_text = excluded.raw_text,
       normalized_name = excluded.normalized_name,
       main_category = excluded.main_category,
       fetched_at = excluded.fetched_at`,
  ).run(input.schoolId, input.date, input.rawText, input.normalizedName ?? null, input.mainCategory ?? null, input.fetchedAt);
}

/** Lunch Entries of one School with `from <= date <= to` (inclusive), ordered by date. */
export function listLunchEntries(db: Database.Database, schoolId: number, from: string, to: string): StoredLunchEntry[] {
  return (
    db.prepare(`${SELECT} WHERE school_id = ? AND date >= ? AND date <= ? ORDER BY date`).all(schoolId, from, to) as Row[]
  ).map(toEntry);
}

/** Every active School with its Lunch Entry for `date`, or null when it has no lunch data. */
export function listLunchForDate(db: Database.Database, date: string): SchoolLunch[] {
  const rows = db.prepare(`${SELECT} WHERE date = ?`).all(date) as Row[];
  const bySchool = new Map(rows.map((row) => [row.school_id, toEntry(row)]));
  return listActiveSchools(db).map((school) => ({ school, entry: bySchool.get(school.id) ?? null }));
}
