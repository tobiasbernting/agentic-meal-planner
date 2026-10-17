import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, writeSetting } from "../db.js";
import { createDish, listDishes } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent, type LlmResult, type SelectedDish } from "../llm/index.js";
import { createCapturingLogger } from "../logging/logger.js";
import { listLunchEntries } from "../lunch/repo.js";
import { confirmPlan, getPlanForWeek } from "../planner/repo.js";
import { createSchool } from "../schools/repo.js";
import { buildAndPushShoppingList } from "../shopping/build-and-push.js";
import { createPlanRunRegistry } from "../plan-run/registry.js";
import { buildApp } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { runWithRunId } from "../logging/run-context.js";
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
    const deps = { db, llm: new NoAgent(), fetchPage: async () => "", now: () => SUNDAY, afterPlan: async ({ planId }: { planId: number }) => void seen.push(planId) };

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

  it("logs each Phase of the Plan Run under the cron run id, with Ingredient resolution progress", async () => {
    const db = freshDb();
    createDish(db, { name: "Burgers", prepTimeMinutes: 20 });
    const { logger, records } = createCapturingLogger();
    const runId = "cron-2026-10-11T16:00:00.000Z";
    const llm = new ScriptedLlmAgent({ findRecipe: { ok: true, value: { url: "https://recipes.example/b", ingredients: [{ name: "Beef" }] } } });
    const fetchPage = async () => "";

    await runWeeklyPlanning({
      db,
      llm,
      fetchPage,
      now: () => SUNDAY,
      log: logger.child({ runId }),
      afterPlan: ({ planId, log, onProgress }) => buildAndPushShoppingList({ db, llm, fetchPage, log, onProgress }, planId),
    });

    const planRun = records.filter((r) => r.component === "plan-run");
    expect(planRun.every((r) => r.level === "info" && r.runId === runId && r.weekStart === NEXT_MONDAY)).toBe(true);
    expect(planRun.filter((r) => r.msg === "phase").map((r) => r.phase)).toEqual([
      "lunch-ingest",
      "dish-selection",
      "ingredient-resolution",
      "pantry-matching",
      "shopping-list-push",
    ]);
    const progress = planRun.filter((r) => r.msg === "phase progress");
    expect(progress.map((r) => [r.done, r.total])).toEqual([0, 1, 2, 3, 4, 5, 6].map((done) => [done, 7]));
    expect(progress[0]?.dish).toBe("Burgers"); // Once a Week: seed fallbacks fill the other dates
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
    const kalops = dishes.find((d) => d.name === "Kalops");
    expect(kalops).toEqual(expect.objectContaining({ name: "Kalops", inRotation: false, suggested: true }));
    expect(getPlanForWeek(db, NEXT_MONDAY)?.dinners[0]?.dishId).toBe(kalops!.id);
  });

  it("skips a week whose Plan Run is in flight, with one log record and no agent call", async () => {
    const db = freshDb();
    createDish(db, { name: "Burgers", prepTimeMinutes: 20 });
    createSchool(db, { name: "Skolan", url: "https://example.test/menu" });
    const planRuns = createPlanRunRegistry();
    planRuns.start(NEXT_MONDAY, { runId: "req-1", startedAt: SUNDAY });
    const llm = new ScriptedLlmAgent({});
    const fetched: string[] = [];
    const { logger, records } = createCapturingLogger();
    const runId = "cron-2026-10-11T16:00:00.000Z";

    const result = await runWeeklyPlanning({
      db,
      llm,
      fetchPage: async (url) => (fetched.push(url), ""),
      now: () => SUNDAY,
      log: logger.child({ runId }),
      planRuns,
    });

    expect(result.plan).toEqual({ skipped: "in-flight" });
    expect(llm.calls).toEqual([]);
    expect(fetched).toEqual([]);
    expect(getPlanForWeek(db, NEXT_MONDAY)).toBeUndefined();
    expect(records).toEqual([expect.objectContaining({ level: "info", runId, weekStart: NEXT_MONDAY, reason: "in-flight" })]);
  });

  it("shows the scheduled run in flight on the Plan page banner, then finished", async () => {
    let release!: (value: LlmResult<SelectedDish[]>) => void;
    const held = new Promise<LlmResult<SelectedDish[]>>((r) => (release = r));
    const llm = new ScriptedLlmAgent({ selectDishes: () => held });
    const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "scheduler-banner-")), llm, now: () => SUNDAY }));
    try {
      createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
      const { logger, records } = createCapturingLogger();
      const runId = "cron-2026-10-11T16:00:00.000Z";
      const deps = { ...app.ctx, llm, log: logger.child({ runId }), planRuns: app.ctx.planRuns };

      const run = runWithRunId(runId, () => runWeeklyPlanning(deps));
      await new Promise((resolve) => setTimeout(resolve, 5));

      const inFlight = await app.inject({ method: "GET", url: `/plan?week=${NEXT_MONDAY}` });
      expect(inFlight.body).toContain("Plan Run in progress since 18:00");
      expect(inFlight.body).toContain("Dish selection");
      expect(inFlight.body).toContain('hx-trigger="every 2s"');
      expect(inFlight.body).not.toContain('action="/plan/generate"');

      const second = await runWithRunId("cron-later", () => runWeeklyPlanning(deps));
      expect(second.plan).toEqual({ skipped: "in-flight" });

      release({ ok: false, reason: "released" });
      await run;
      const finished = await app.inject({ method: "GET", url: `/plan-run/banner?week=${NEXT_MONDAY}` });
      expect(finished.body).toContain("Plan Run finished 18:00");
      expect(finished.body).not.toContain("hx-trigger");
      expect(records.filter((r) => r.component === "plan-run" && r.msg === "phase").every((r) => r.runId === runId)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("runWeeklyPlanning that throws", () => {
  it("logs the error under the cron run id, marks the run failed, and rethrows", async () => {
    const db = freshDb();
    createDish(db, { name: "Burgers", prepTimeMinutes: 20 });
    const planRuns = createPlanRunRegistry();
    const { logger, records } = createCapturingLogger();
    const runId = "cron-2026-10-11T16:00:00.000Z";
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });

    await expect(runWeeklyPlanning({ db, llm, fetchPage: async () => "", now: () => SUNDAY, log: logger.child({ runId }), planRuns })).rejects.toThrow(
      "agent exploded",
    );

    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", component: "plan-run", runId, weekStart: NEXT_MONDAY, err: "agent exploded" }),
    );
    expect(planRuns.get(NEXT_MONDAY)).toMatchObject({ outcome: { kind: "failed", message: "agent exploded" } });
  });
});
