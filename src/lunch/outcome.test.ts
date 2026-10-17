import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createSchool, deleteSchool } from "../schools/repo.js";
import { getIngestOutcome, listIngestOutcomes, recordIngestOutcome } from "./outcome.js";

const dbs: Database.Database[] = [];

function freshDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-outcome-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

describe("Ingest Outcome repository", () => {
  it("keeps only the latest outcome per School, replaced on every attempt", () => {
    const db = freshDb();
    const school = createSchool(db, { name: "Northside", url: "https://north.example/menu" });
    expect(getIngestOutcome(db, school.id)).toBeNull();

    recordIngestOutcome(db, { schoolId: school.id, weekStart: "2026-10-19", status: "no-data", reason: "fetch failed: boom", recordedAt: "2026-10-19T06:00:00.000Z" });
    recordIngestOutcome(db, { schoolId: school.id, weekStart: "2026-10-19", status: "fetched", reason: null, recordedAt: "2026-10-19T07:00:00.000Z" });

    expect(getIngestOutcome(db, school.id)).toEqual({
      schoolId: school.id,
      weekStart: "2026-10-19",
      status: "fetched",
      reason: null,
      recordedAt: "2026-10-19T07:00:00.000Z",
    });
    expect(listIngestOutcomes(db)).toHaveLength(1);
  });

  it("is removed with its School", () => {
    const db = freshDb();
    const school = createSchool(db, { name: "Northside", url: "https://north.example/menu" });
    recordIngestOutcome(db, { schoolId: school.id, weekStart: "2026-10-19", status: "cached", reason: null, recordedAt: "2026-10-19T07:00:00.000Z" });

    deleteSchool(db, school.id);

    expect(listIngestOutcomes(db)).toEqual([]);
  });
});
