import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, writeSetting } from "../db.js";
import { createDish, listDishes } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent } from "../llm/index.js";
import { createCapturingLogger } from "../logging/logger.js";
import { listLunchEntries } from "../lunch/repo.js";
import { confirmPlan, getPlanForWeek } from "../planner/repo.js";
import { createSchool } from "../schools/repo.js";
import { runWeeklyPlanning } from "./run-weekly.js";

// Sunday 2026-10-11 18:00 local (week of Monday 10-05): the run plans the coming week, Monday 2026-10-12.
const SUNDAY = new Date(2026, 9, 11, 18, 0, 0);
const NEXT_MONDAY = "2026-10-12";

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "scheduler-run-")));
}

describe("runWeeklyPlanning", () => {
  it("ingests lunch for and plans the coming week (FR-9)", async () => {
    const db = freshDb();
    createDish(db, { name: "Burgers", prepTimeMinutes: 20 });
    const school = createSchool(db, { name: "Skolan", url: "https://example.test/menu" });
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: { ok: true, value: [{ date: "2026-10-12", rawText: "Fiskpinnar" }] },
      selectDishes: { ok: true, value: [] },
    });
    const fetched: string[] = [];
    const fetchPage = async (url: string) => {
      fetched.push(url);
      return "<html>menu</html>";
    };

    const result = await runWeeklyPlanning({ db, llm, fetchPage, now: () => SUNDAY });

    expect(result.weekStart).toBe(NEXT_MONDAY);
    expect(fetched).toEqual([school.url]);
    expect(result.ingest.results).toEqual([{ schoolId: school.id, status: "ok", changed: [] }]);
    expect(listLunchEntries(db, school.id, NEXT_MONDAY, NEXT_MONDAY)).toHaveLength(1);
    expect(result.plan).toEqual({ planId: expect.any(Number), degradedReasons: [] });
    const stored = getPlanForWeek(db, NEXT_MONDAY);
    expect(stored?.dinners).toHaveLength(7);
    expect(stored?.dinners[0]?.lunchThatDay).toBe("Fiskpinnar");
  });

  it("plans the coming week of the configured timezone", async () => {
    const db = freshDb();
    writeSetting(db, "timezone", "Europe/Stockholm");
    const instant = new Date("2026-10-11T23:30:00Z"); // Sunday in UTC, already Monday in Stockholm

    const result = await runWeeklyPlanning({ db, llm: new NoAgent(), fetchPage: async () => "", now: () => instant });

    expect(result.weekStart).toBe("2026-10-19");
  });

  it("skips a confirmed plan for that week and leaves it untouched (FR-9a)", async () => {
    const db = freshDb();
    createDish(db, { name: "A", prepTimeMinutes: 20 });
    const deps = { db, llm: new NoAgent(), fetchPage: async () => "", now: () => SUNDAY };
    const first = await runWeeklyPlanning(deps);
    confirmPlan(db, NEXT_MONDAY);
    const before = getPlanForWeek(db, NEXT_MONDAY);

    createSchool(db, { name: "Skolan", url: "https://example.test/menu" });
    const fetched: string[] = [];
    const second = await runWeeklyPlanning({
      ...deps,
      fetchPage: async (url) => (fetched.push(url), ""),
      now: () => new Date(2026, 9, 11, 19, 0, 0),
    });

    expect(first.plan).toMatchObject({ planId: expect.any(Number) });
    expect(second.plan).toEqual({ skipped: "confirmed" });
    expect(fetched).toEqual([]); // a confirmed week is not even ingested
    expect(second.ingest).toEqual({ results: [], changed: [] });
    expect(getPlanForWeek(db, NEXT_MONDAY)).toEqual(before);
  });

  it("calls the afterPlan hook with the new plan id, not when skipped", async () => {
    const db = freshDb();
    createDish(db, { name: "A", prepTimeMinutes: 20 });
    const seen: number[] = [];
    const deps = { db, llm: new NoAgent(), fetchPage: async () => "", now: () => SUNDAY, afterPlan: async (planId: number) => void seen.push(planId) };

    const first = await runWeeklyPlanning(deps);
    confirmPlan(db, NEXT_MONDAY);
    await runWeeklyPlanning(deps);

    expect(first.plan).toMatchObject({ planId: seen[0] });
    expect(seen).toHaveLength(1);
  });

  it("warns on the cron run logger and logs a plan summary with the afterPlan push count", async () => {
    const db = freshDb();
    createDish(db, { name: "Burgers", prepTimeMinutes: 20 });
    createSchool(db, { name: "Skolan", url: "https://example.test/menu" });
    const { logger, records } = createCapturingLogger();
    const log = logger.child({ runId: "cron-2026-10-11T16:00:00.000Z" });
    const fetchPage = async () => {
      throw new Error("HTTP 500 fetching https://example.test/menu");
    };

    await runWeeklyPlanning({ db, llm: new NoAgent(), fetchPage, now: () => SUNDAY, log, afterPlan: async () => 2 });

    const runId = "cron-2026-10-11T16:00:00.000Z";
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", runId, component: "lunch-ingest", msg: "menu fetch failed" }));
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", runId, component: "planner" }));
    expect(records).toContainEqual(expect.objectContaining({ level: "info", runId, msg: "plan summary", dinners: 7, degraded: true, sinksPushed: 2 }));
  });

  it("stores an agent suggestion as a Suggested Dish the coming week's plan points at", async () => {
    const db = freshDb();
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({
        ok: true,
        value: input.days.map((d) => ({ date: d.date, suggestion: { name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 }, rationale: "new" })),
      }),
    });

    await runWeeklyPlanning({ db, llm, fetchPage: async () => "", now: () => SUNDAY });

    const dishes = listDishes(db);
    expect(dishes).toEqual([expect.objectContaining({ name: "Kalops", inRotation: false, suggested: true })]);
    expect(getPlanForWeek(db, NEXT_MONDAY)?.dinners.map((d) => d.dishId)).toEqual(Array(7).fill(dishes[0]!.id));
  });
});
