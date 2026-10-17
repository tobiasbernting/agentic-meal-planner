import type Database from "better-sqlite3";

export type IngestOutcomeStatus = "fetched" | "cached" | "no-data";

/** The latest lunch ingest attempt for one School (GLOSSARY: Ingest Outcome). */
export interface IngestOutcome {
  schoolId: number;
  /** Monday of the week the attempt was for. */
  weekStart: string;
  status: IngestOutcomeStatus;
  reason: string | null;
  /** ISO timestamp of the attempt. */
  recordedAt: string;
}

interface Row {
  school_id: number;
  week_start: string;
  status: IngestOutcomeStatus;
  reason: string | null;
  recorded_at: string;
}

const SELECT = "SELECT school_id, week_start, status, reason, recorded_at FROM ingest_outcome";

function toOutcome(row: Row): IngestOutcome {
  return { schoolId: row.school_id, weekStart: row.week_start, status: row.status, reason: row.reason, recordedAt: row.recorded_at };
}

/** Stores the outcome of an ingest attempt, replacing the School's previous one. */
export function recordIngestOutcome(db: Database.Database, outcome: IngestOutcome): void {
  db.prepare(
    `INSERT INTO ingest_outcome (school_id, week_start, status, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(school_id) DO UPDATE SET
       week_start = excluded.week_start,
       status = excluded.status,
       reason = excluded.reason,
       recorded_at = excluded.recorded_at`,
  ).run(outcome.schoolId, outcome.weekStart, outcome.status, outcome.reason, outcome.recordedAt);
}

export function getIngestOutcome(db: Database.Database, schoolId: number): IngestOutcome | null {
  const row = db.prepare(`${SELECT} WHERE school_id = ?`).get(schoolId) as Row | undefined;
  return row ? toOutcome(row) : null;
}

export function listIngestOutcomes(db: Database.Database): IngestOutcome[] {
  return (db.prepare(`${SELECT} ORDER BY school_id`).all() as Row[]).map(toOutcome);
}
