import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { ScriptedLlmAgent } from "../llm/index.js";
import { createSchool, setSchoolActive } from "../schools/repo.js";
import { ingestWeek } from "./ingest.js";
import { listLunchEntries, listLunchForDate, upsertLunchEntry } from "./repo.js";

const dbs: Database.Database[] = [];

function freshDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-ingest-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

const WEEK = "2026-10-19";
const NOW = new Date("2026-10-18T18:00:00Z");

const PLUGIN_URL = "https://north.example/menu.lunch.json";
const PLUGIN_PAGE = JSON.stringify({
  days: [
    { date: "2026-10-19", dishes: ["Pasta bolognese"] },
    { date: "2026-10-20", dishes: ["Fiskgratäng"] },
  ],
});

const LLM_URL = "https://south.example/lunch-menu";
const LLM_PAGE = "<html>Mon: Köttbullar. Tue: Kycklinggryta</html>";

function pages(): Record<string, string> {
  return { [PLUGIN_URL]: PLUGIN_PAGE, [LLM_URL]: LLM_PAGE };
}

function fetcher(fetched: string[]) {
  return async (url: string) => {
    fetched.push(url);
    const page = pages()[url];
    if (page === undefined) throw new Error(`no fixture for ${url}`);
    return page;
  };
}

describe("ingestWeek", () => {
  it("uses the School Plugin that claims the URL and stores one Lunch Entry per date", async () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: PLUGIN_URL });
    const llm = new ScriptedLlmAgent();
    const fetched: string[] = [];

    const result = await ingestWeek({ db, llm, fetchPage: fetcher(fetched), now: () => NOW }, WEEK);

    expect(result.results).toEqual([{ schoolId: north.id, status: "ok", changed: [] }]);
    expect(llm.calls).toEqual([]);
    expect(listLunchEntries(db, north.id, WEEK, "2026-10-25")).toEqual([
      { schoolId: north.id, date: "2026-10-19", rawText: "Pasta bolognese", normalizedName: null, mainCategory: null, fetchedAt: NOW.toISOString() },
      { schoolId: north.id, date: "2026-10-20", rawText: "Fiskgratäng", normalizedName: null, mainCategory: null, fetchedAt: NOW.toISOString() },
    ]);
  });

  it("falls back to the LLM for an unclaimed URL and keeps only valid Main Categories", async () => {
    const db = freshDb();
    const south = createSchool(db, { name: "Southside", url: LLM_URL });
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: {
        ok: true,
        value: [
          { date: "2026-10-19", rawText: "Köttbullar", normalizedName: "köttbullar", mainCategory: "beef" },
          { date: "2026-10-20", rawText: "Kycklinggryta", mainCategory: "Poultry" },
        ],
      },
    });
    const fetched: string[] = [];

    const result = await ingestWeek({ db, llm, fetchPage: fetcher(fetched), now: () => NOW }, WEEK);

    expect(result.results).toEqual([{ schoolId: south.id, status: "ok", changed: [] }]);
    expect(fetched).toEqual([LLM_URL]);
    expect(llm.calls).toEqual([{ method: "extractLunchMenu", args: [LLM_PAGE, WEEK] }]);
    expect(listLunchEntries(db, south.id, WEEK, "2026-10-25")).toEqual([
      { schoolId: south.id, date: "2026-10-19", rawText: "Köttbullar", normalizedName: "köttbullar", mainCategory: "beef", fetchedAt: NOW.toISOString() },
      { schoolId: south.id, date: "2026-10-20", rawText: "Kycklinggryta", normalizedName: null, mainCategory: null, fetchedAt: NOW.toISOString() },
    ]);
  });

  it("merges several LLM entries for one date into one Lunch Entry", async () => {
    const db = freshDb();
    const south = createSchool(db, { name: "Southside", url: LLM_URL });
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: {
        ok: true,
        value: [
          { date: "2026-10-19", rawText: "Köttbullar", mainCategory: "beef" },
          { date: "2026-10-19", rawText: "Vegetarisk lasagne", mainCategory: "vegetarian" },
        ],
      },
    });

    await ingestWeek({ db, llm, fetchPage: fetcher([]), now: () => NOW }, WEEK);

    expect(listLunchEntries(db, south.id, WEEK, WEEK)).toEqual([
      { schoolId: south.id, date: "2026-10-19", rawText: "Köttbullar\nVegetarisk lasagne", normalizedName: null, mainCategory: "beef", fetchedAt: NOW.toISOString() },
    ]);
  });

  it("does not re-fetch a School whose weekdays are already cached", async () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: PLUGIN_URL });
    for (const date of ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
      upsertLunchEntry(db, { schoolId: north.id, date, rawText: "Cached", fetchedAt: "2026-10-17T00:00:00.000Z" });
    }
    const fetched: string[] = [];

    const result = await ingestWeek({ db, llm: new ScriptedLlmAgent(), fetchPage: fetcher(fetched), now: () => NOW }, WEEK);

    expect(result.results).toEqual([{ schoolId: north.id, status: "cached", changed: [] }]);
    expect(fetched).toEqual([]);
    expect(listLunchEntries(db, north.id, WEEK, WEEK)[0]?.rawText).toBe("Cached");
  });

  it("re-fetches a School with a partially cached week", async () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: PLUGIN_URL });
    upsertLunchEntry(db, { schoolId: north.id, date: "2026-10-19", rawText: "Cached", fetchedAt: "2026-10-17T00:00:00.000Z" });
    const fetched: string[] = [];

    const result = await ingestWeek({ db, llm: new ScriptedLlmAgent(), fetchPage: fetcher(fetched), now: () => NOW }, WEEK);

    expect(result.results[0]?.status).toBe("ok");
    expect(fetched).toEqual([PLUGIN_URL]);
  });

  it("stores nothing and reports no-data when the LLM degrades, so the notice can be shown", async () => {
    const db = freshDb();
    const south = createSchool(db, { name: "Southside", url: LLM_URL });
    const llm = new ScriptedLlmAgent({ extractLunchMenu: { ok: false, reason: "no agent configured" } });

    const result = await ingestWeek({ db, llm, fetchPage: fetcher([]), now: () => NOW }, WEEK);

    expect(result.results).toEqual([{ schoolId: south.id, status: "no-data", reason: "no agent configured", changed: [] }]);
    expect(listLunchForDate(db, "2026-10-19")).toEqual([{ school: expect.objectContaining({ id: south.id }), entry: null }]);
  });

  it("reports no-data when the page cannot be fetched or the menu is empty", async () => {
    const db = freshDb();
    const broken = createSchool(db, { name: "Broken", url: "https://down.example/menu" });
    const empty = createSchool(db, { name: "Empty", url: "https://empty.example/menu.lunch.json" });
    const fetchPage = async (url: string) => {
      if (url.startsWith("https://down.")) throw new Error("ECONNREFUSED");
      return JSON.stringify({ days: [] });
    };

    const result = await ingestWeek({ db, llm: new ScriptedLlmAgent(), fetchPage, now: () => NOW }, WEEK);

    expect(result.results).toEqual([
      { schoolId: broken.id, status: "no-data", reason: "fetch failed: ECONNREFUSED", changed: [] },
      { schoolId: empty.id, status: "no-data", reason: "no entries for this week", changed: [] },
    ]);
  });

  it("skips paused Schools", async () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: PLUGIN_URL });
    setSchoolActive(db, north.id, false);
    const fetched: string[] = [];

    const result = await ingestWeek({ db, llm: new ScriptedLlmAgent(), fetchPage: fetcher(fetched), now: () => NOW }, WEEK);

    expect(result.results).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("with force, re-scrapes a cached School and reports which stored entries changed", async () => {
    const db = freshDb();
    const north = createSchool(db, { name: "Northside", url: PLUGIN_URL });
    for (const date of ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
      upsertLunchEntry(db, { schoolId: north.id, date, rawText: date === "2026-10-19" ? "Pasta bolognese" : "Old", fetchedAt: "2026-10-17T00:00:00.000Z" });
    }

    const result = await ingestWeek({ db, llm: new ScriptedLlmAgent(), fetchPage: fetcher([]), now: () => NOW }, WEEK, { force: true });

    const changed = [{ schoolId: north.id, date: "2026-10-20", before: "Old", after: "Fiskgratäng" }];
    expect(result.results).toEqual([{ schoolId: north.id, status: "ok", changed }]);
    expect(result.changed).toEqual(changed);
    expect(listLunchEntries(db, north.id, WEEK, "2026-10-25").map((e) => [e.date, e.rawText])).toEqual([
      ["2026-10-19", "Pasta bolognese"],
      ["2026-10-20", "Fiskgratäng"],
      ["2026-10-21", "Old"],
      ["2026-10-22", "Old"],
      ["2026-10-23", "Old"],
    ]);
  });
});
