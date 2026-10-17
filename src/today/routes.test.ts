import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { writeSetting } from "../db.js";
import { createDish } from "../dishes/repo.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { NO_ELIGIBLE_DISH_RATIONALE, type PlannedDinnerDraft } from "../planner/plan-week.js";
import { savePlan } from "../planner/repo.js";
import { createSchool, setSchoolActive } from "../schools/repo.js";
import { createCapturingLogger } from "../logging/logger.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time.
const NOW = new Date(2026, 9, 21, 18, 30);
const TODAY = "2026-10-21";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-today-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("timezone setting", () => {
  it("decides which date is today (23:30 UTC is already tomorrow in Stockholm)", async () => {
    const app = await start({ now: () => new Date("2026-10-21T23:30:00Z") });
    writeSetting(app.ctx.db, "timezone", "Europe/Stockholm");

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toContain('<time datetime="2026-10-22">');
  });
});

describe("GET / (Today view)", () => {
  it("shows today's date and each active School's Lunch Entry, one dish per line", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    upsertLunchEntry(app.ctx.db, {
      schoolId: north.id,
      date: TODAY,
      rawText: "Pasta bolognese\nFiskgratäng",
      fetchedAt: NOW.toISOString(),
    });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(TODAY);
    expect(res.body).toContain("Northside");
    expect(res.body).toMatch(/<li>Pasta bolognese<\/li>\s*<li>Fiskgratäng<\/li>/);
    expect(res.body).not.toContain("Northside: plugin example-json failed: offline");
  });

  it("shows the no-lunch-data notice for a School without an entry today (FR-5)", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    createSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Yesterday's soup", fetchedAt: NOW.toISOString() });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toContain("Northside");
    expect(res.body).toContain("Southside");
    expect(res.body).not.toContain("Yesterday's soup");
    expect(res.body.match(/No lunch data/g)).toHaveLength(2);
  });

  it("omits paused Schools", async () => {
    const app = await start();
    const paused = createSchool(app.ctx.db, { name: "Paused School", url: "https://paused.example/menu" });
    setSchoolActive(app.ctx.db, paused.id, false);

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).not.toContain("Paused School");
  });

  describe("dinner section (FR-17a)", () => {
    const WEEK_START = "2026-10-19";
    const dinner = (overrides: Partial<PlannedDinnerDraft>): PlannedDinnerDraft => ({
      date: TODAY,
      dishId: null,
      isQuickDay: false,
      lunchThatDay: null,
      rationale: "",
      ...overrides,
    });

    it("shows today's Planned Dinner: Dish name, recipe link and rationale", async () => {
      const app = await start();
      const dishId = createDish(app.ctx.db, { name: "Tacos", recipeUrl: "https://recipes.example/tacos" });
      savePlan(
        app.ctx.db,
        {
          weekStart: WEEK_START,
          dinners: [
            dinner({ date: "2026-10-20", dishId, rationale: "yesterday's pick" }),
            dinner({ dishId, rationale: "quick on a busy evening" }),
          ],
          degradedReasons: [],
        },
        NOW.toISOString(),
      );

      const res = await app.inject({ method: "GET", url: "/" });

      const section = res.body.match(/<section id="dinner">[\s\S]*?<\/section>/)![0];
      expect(section).toContain("Tacos");
      expect(section).toContain(`<a href="https://recipes.example/tacos"`);
      expect(section).toContain("quick on a busy evening");
      expect(section).not.toContain("yesterday's pick");
      expect(section).not.toContain("No plan yet");
    });

    it("says there is no plan yet, with a link to /plan, before a plan exists", async () => {
      const app = await start();

      const res = await app.inject({ method: "GET", url: "/" });

      expect(res.body).toMatch(/<section id="dinner">[\s\S]*No plan yet[\s\S]*<a href="\/plan">/);
    });

    it("tells the household to pick a dish when today's dinner has no eligible Dish", async () => {
      const app = await start();
      savePlan(
        app.ctx.db,
        { weekStart: WEEK_START, dinners: [dinner({ rationale: NO_ELIGIBLE_DISH_RATIONALE })], degradedReasons: [] },
        NOW.toISOString(),
      );

      const res = await app.inject({ method: "GET", url: "/" });

      expect(res.body).toMatch(/<section id="dinner">[\s\S]*No eligible dish, pick one/);
      expect(res.body).not.toContain("No plan yet");
    });
  });
});

describe("POST /lunch/refresh", () => {
  it("ingests the current week through the injected fetchPage and redirects to the Today view", async () => {
    const url = "https://north.example/menu.lunch.json";
    const fetched: string[] = [];
    const app = await start({
      fetchPage: async (u) => {
        fetched.push(u);
        return JSON.stringify({ days: [{ date: TODAY, dishes: ["Pannkakor", "Ärtsoppa"] }] });
      },
    });
    createSchool(app.ctx.db, { name: "Northside", url });

    const res = await app.inject({ method: "POST", url: "/lunch/refresh" });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");
    expect(fetched).toEqual([url]);
    const today = await app.inject({ method: "GET", url: "/" });
    expect(today.body).toMatch(/<li>Pannkakor<\/li>\s*<li>Ärtsoppa<\/li>/);
  });

  it("still redirects when a School's fetch fails", async () => {
    const app = await start({
      fetchPage: async () => {
        throw new Error("offline");
      },
    });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu.lunch.json" });

    const res = await app.inject({ method: "POST", url: "/lunch/refresh" });

    expect(res.statusCode).toBe(303);
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("Northside: plugin example-json failed: offline");
  });

});

describe("POST /lunch/refresh logging", () => {
  it("logs the ingest run with runId = request id and component lunch", async () => {
    const { logger, records } = createCapturingLogger();
    const app = await start({ logger });

    await app.inject({ method: "POST", url: "/lunch/refresh" });

    const runId = records.find((r) => r.msg === "request completed" && r.url === "/lunch/refresh")?.runId;
    expect(runId).toEqual(expect.any(String));
    const run = records.filter((r) => r.runId === runId);
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "run started", component: "lunch", weekStart: "2026-10-19" }));
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "run finished", component: "lunch" }));
  });
});
