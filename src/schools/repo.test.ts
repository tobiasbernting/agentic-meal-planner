import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createSchool, listActiveSchools, listSchools, setSchoolActive } from "./repo.js";

const dbs: Database.Database[] = [];

function freshDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-schools-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

describe("School repository", () => {
  it("saves two Schools with different menu URLs", () => {
    const db = freshDb();

    createSchool(db, { name: "Northside", url: "https://skolmaten.se/northside" });
    createSchool(db, { name: "Southside", url: "https://mashie.com/southside" });

    expect(listSchools(db).map((s) => [s.name, s.url])).toEqual([
      ["Northside", "https://skolmaten.se/northside"],
      ["Southside", "https://mashie.com/southside"],
    ]);
  });

  it("keeps a paused School but leaves it out of the Schools to scrape", () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: "https://skolmaten.se/northside" });
    createSchool(db, { name: "Southside", url: "https://mashie.com/southside" });

    setSchoolActive(db, north.id, false);

    expect(listSchools(db).map((s) => [s.name, s.active])).toEqual([
      ["Northside", false],
      ["Southside", true],
    ]);
    expect(listActiveSchools(db).map((s) => s.name)).toEqual(["Southside"]);
  });
});
