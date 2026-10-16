import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createSchool, deleteSchool, setSchoolActive } from "../schools/repo.js";
import { listLunchEntries, listLunchForDate, upsertLunchEntry } from "./repo.js";

const dbs: Database.Database[] = [];

function freshDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-lunch-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

const FETCHED = "2026-10-18T10:00:00.000Z";

describe("Lunch Entry repository", () => {
  it("stores one Lunch Entry per School and date and lists them by date range", () => {
    const db = freshDb();
    const school = createSchool(db, { name: "Northside", url: "https://example.lunch.json" });

    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-19", rawText: "Pasta bolognese", mainCategory: "pasta", fetchedAt: FETCHED });
    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-20", rawText: "Fiskgratäng", mainCategory: "fish", fetchedAt: FETCHED });
    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-26", rawText: "Next week", fetchedAt: FETCHED });

    expect(listLunchEntries(db, school.id, "2026-10-19", "2026-10-25")).toEqual([
      { schoolId: school.id, date: "2026-10-19", rawText: "Pasta bolognese", normalizedName: null, mainCategory: "pasta", fetchedAt: FETCHED },
      { schoolId: school.id, date: "2026-10-20", rawText: "Fiskgratäng", normalizedName: null, mainCategory: "fish", fetchedAt: FETCHED },
    ]);
  });

  it("replaces the entry when the same School and date is stored again", () => {
    const db = freshDb();
    const school = createSchool(db, { name: "Northside", url: "https://example.lunch.json" });
    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-19", rawText: "Pasta bolognese", mainCategory: "pasta", fetchedAt: FETCHED });

    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-19", rawText: "Köttbullar", normalizedName: "köttbullar", mainCategory: "beef", fetchedAt: FETCHED });

    expect(listLunchEntries(db, school.id, "2026-10-19", "2026-10-19")).toEqual([
      { schoolId: school.id, date: "2026-10-19", rawText: "Köttbullar", normalizedName: "köttbullar", mainCategory: "beef", fetchedAt: FETCHED },
    ]);
  });

  it("lists every active School for a date, with null for a School without lunch data", () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: "https://north.lunch.json" });
    const south = createSchool(db, { name: "Southside", url: "https://south.example" });
    const paused = createSchool(db, { name: "Paused", url: "https://paused.example" });
    setSchoolActive(db, paused.id, false);
    upsertLunchEntry(db, { schoolId: north.id, date: "2026-10-19", rawText: "Pasta bolognese", fetchedAt: FETCHED });

    const forDate = listLunchForDate(db, "2026-10-19");

    expect(forDate.map((d) => [d.school.name, d.entry?.rawText ?? null])).toEqual([
      ["Northside", "Pasta bolognese"],
      ["Southside", null],
    ]);
  });

  it("drops a School's Lunch Entries when the School is deleted", () => {
    const db = freshDb();
    const school = createSchool(db, { name: "Northside", url: "https://north.lunch.json" });
    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-19", rawText: "Pasta bolognese", fetchedAt: FETCHED });

    deleteSchool(db, school.id);

    expect(listLunchEntries(db, school.id, "2026-10-01", "2026-12-31")).toEqual([]);
  });
});
