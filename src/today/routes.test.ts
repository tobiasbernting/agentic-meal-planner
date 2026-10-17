import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { writeSetting } from "../db.js";
import { createDish } from "../dishes/repo.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import type { PlannedDinnerDraft } from "../planner/plan-week.js";
import { savePlan, setPlannedDinnerSource } from "../planner/repo.js";
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

// Helpers to read the almanac page.
/** The almanac row for `date`. */
function row(body: string, date: string): string {
  const m = body.match(new RegExp(`<article[^>]*id="day-${date}"[\\s\\S]*?</article>`));
  if (!m) throw new Error(`no row for ${date}`);
  return m[0];
}
/** The opening tag of the row for `date`. */
function rowTag(body: string, date: string): string {
  return row(body, date).match(/^<article[^>]*>/)![0];
}

const WEEK_START = "2026-10-19";
const TOMORROW = "2026-10-22";
const dinner = (overrides: Partial<PlannedDinnerDraft>): PlannedDinnerDraft => ({
  date: TODAY,
  dishId: null,
  isQuickDay: false,
  lunchThatDay: null,
  rationale: "",
  ...overrides,
});
function plan(app: Awaited<ReturnType<typeof start>>, dinners: PlannedDinnerDraft[], weekStart = WEEK_START): number {
  return savePlan(app.ctx.db, { weekStart, dinners, degradedReasons: [] }, NOW.toISOString());
}

describe("timezone setting", () => {
  it("decides which date is today (23:30 UTC is already tomorrow in Stockholm)", async () => {
    const app = await start({ now: () => new Date("2026-10-21T23:30:00Z") });
    writeSetting(app.ctx.db, "timezone", "Europe/Stockholm");

    const res = await app.inject({ method: "GET", url: "/" });

    expect(rowTag(res.body, "2026-10-22")).toContain('aria-current="date"');
    expect(rowTag(res.body, "2026-10-21")).not.toContain('aria-current="date"');
  });
});

describe("GET / (Today as almanac page)", () => {
  it("opens on the ISO week number and the month", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<h1 class="week-num"[^>]*><small>wk<\/small>43<\/h1>/);
    expect(res.body).toContain('<div class="week-month">October 2026</div>');
  });

  it("shows the week Monday to Sunday: today expanded, tomorrow half-open, the rest compact", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/" });

    const dates = [...res.body.matchAll(/<article[^>]*id="day-([\d-]+)"/g)].map((m) => m[1]);
    expect(dates).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(rowTag(res.body, TODAY)).toMatch(/class="day day-full day-today"/);
    expect(rowTag(res.body, TOMORROW)).toMatch(/class="day day-half"/);
    for (const date of ["2026-10-19", "2026-10-20", "2026-10-23", "2026-10-24", "2026-10-25"]) {
      expect(rowTag(res.body, date)).toMatch(/class="day day-compact/);
    }
    expect(row(res.body, TODAY)).toMatch(/<b>21<\/b><span>Wed<\/span>/);
  });

  it("on a Sunday, adds tomorrow (next Monday) half-open after the week", async () => {
    const app = await start({ now: () => new Date(2026, 9, 25, 9, 0) });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(rowTag(res.body, "2026-10-25")).toContain("day-today");
    expect(rowTag(res.body, "2026-10-26")).toMatch(/class="day day-half"/);
  });

  describe("today's row", () => {
    it("shows each School's lunch, the Dinner, minutes, Quick Day tag, rationale, Byt and Recept", async () => {
      const app = await start();
      writeSetting(app.ctx.db, "quick_day_template", JSON.stringify({ wed: 30 }));
      const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
      upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: TODAY, rawText: "Pasta bolognese\nFiskgratäng", fetchedAt: NOW.toISOString() });
      const dishId = createDish(app.ctx.db, { name: "Tacos", recipeUrl: "https://recipes.example/tacos", prepTimeMinutes: 25 });
      plan(app, [
        dinner({ date: "2026-10-20", dishId, rationale: "yesterday's pick" }),
        dinner({ dishId, isQuickDay: true, rationale: "quick on a busy evening" }),
      ]);

      const res = await app.inject({ method: "GET", url: "/" });

      const today = row(res.body, TODAY);
      expect(today).toContain("Lunch · Northside");
      expect(today).toMatch(/<li>Pasta bolognese<\/li>\s*<li>Fiskgratäng<\/li>/);
      expect(today).toMatch(/<div class="day-dinner">Tacos/);
      expect(today).toContain("25 min");
      expect(today).toContain('<span class="tag">Quick Day, max 30 min</span>');
      expect(today).toContain("quick on a busy evening");
      expect(today).not.toContain("yesterday's pick");
      expect(today).toMatch(/<a class="button" href="\/plan\/swap\?date=[^"]*"[^>]*>Swap dish<\/a>/);
      expect(today).toContain('<a class="button" href="https://recipes.example/tacos">Recipe</a>');
    });

    it("links Recept to the LLM-found source when the Dish has no Recipe URL", async () => {
      const app = await start();
      const dishId = createDish(app.ctx.db, { name: "Soppa" });
      const planId = plan(app, [dinner({ dishId })]);
      setPlannedDinnerSource(app.ctx.db, planId, TODAY, "https://found.example/soppa");

      const res = await app.inject({ method: "GET", url: "/" });

      expect(row(res.body, TODAY)).toContain('<a class="button" href="https://found.example/soppa">Recipe</a>');
    });

    it("hides Recept when there is neither a Recipe URL nor a found source", async () => {
      const app = await start();
      const dishId = createDish(app.ctx.db, { name: "Gröt" });
      plan(app, [dinner({ dishId })]);

      const res = await app.inject({ method: "GET", url: "/" });

      expect(row(res.body, TODAY)).toContain("Gröt");
      expect(row(res.body, TODAY)).not.toContain("Recipe");
    });

    it("marks a Suggested Dish and promotes it from Today, returning to Today with the badge gone", async () => {
      const app = await start();
      const dishId = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });
      plan(app, [dinner({ dishId, rationale: "suggested" })]);

      const before = await app.inject({ method: "GET", url: "/" });
      expect(row(before.body, TODAY)).toContain("Suggested");
      expect(row(before.body, TODAY)).toMatch(new RegExp(`<form method="post" action="/dishes/${dishId}/promote"[\\s\\S]*Add to favorites`));

      const post = await app.inject({ method: "POST", url: `/dishes/${dishId}/promote`, headers: { referer: "/" } });
      expect(post.statusCode).toBe(303);
      expect(post.headers.location).toBe("/");

      const after = await app.inject({ method: "GET", url: "/" });
      expect(after.body).toContain("Köttbullar");
      expect(after.body).not.toContain("Suggested");
      expect(after.body).not.toContain("Add to favorites");
    });

    it("tells the household to pick a dish when today's dinner has no eligible Dish", async () => {
      const app = await start();
      plan(app, [dinner({ rationale: "Ingen lämplig rätt, välj en." })]);

      const res = await app.inject({ method: "GET", url: "/" });

      expect(row(res.body, TODAY)).toContain("No eligible dish, pick one");
      expect(row(res.body, TODAY)).not.toContain("No plan yet");
    });
  });

  it("shows tomorrow's lunch, Dinner and minutes, without the rationale", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: TOMORROW, rawText: "Ärtsoppa\nPannkakor", fetchedAt: NOW.toISOString() });
    const dishId = createDish(app.ctx.db, { name: "Lax i ugn", prepTimeMinutes: 40 });
    plan(app, [dinner({ date: TOMORROW, dishId, rationale: "fish midweek" })]);

    const res = await app.inject({ method: "GET", url: "/" });

    const tomorrow = row(res.body, TOMORROW);
    expect(tomorrow).toContain("Ärtsoppa");
    expect(tomorrow).toContain("Lax i ugn");
    expect(tomorrow).toContain("40 min");
    expect(tomorrow).not.toContain("fish midweek");
  });

  it("shows the other days compactly: the lunch on the name-day line and the Dinner", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-23", rawText: "Fiskpinnar\nVegobiff", fetchedAt: NOW.toISOString() });
    const dishId = createDish(app.ctx.db, { name: "Tacos", prepTimeMinutes: 25 });
    plan(app, [dinner({ date: "2026-10-23", dishId, rationale: "friday" })]);

    const res = await app.inject({ method: "GET", url: "/" });

    const friday = row(res.body, "2026-10-23");
    expect(friday).toContain('<div class="day-lunch">Fiskpinnar · Vegobiff</div>');
    expect(friday).toContain('<div class="day-dinner">Tacos</div>');
    expect(friday).not.toContain("25 min");
    expect(friday).not.toContain("friday");
  });

  describe("days with nothing to show say so in plain words", () => {
    it("says there is no plan yet, with a link to /plan, and each other day says no plan", async () => {
      const app = await start();

      const res = await app.inject({ method: "GET", url: "/" });

      expect(row(res.body, TODAY)).toMatch(/No plan yet[\s\S]*<a href="\/plan">Plan this week<\/a>/);
      expect(row(res.body, "2026-10-23")).toContain("No plan");
    });

    it("shows the no-lunch-data block for a School without an entry today (FR-5)", async () => {
      const app = await start();
      const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
      createSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });
      upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Yesterday's soup", fetchedAt: NOW.toISOString() });

      const res = await app.inject({ method: "GET", url: "/" });

      const today = row(res.body, TODAY);
      expect(today).toContain("Northside");
      expect(today).toContain("Southside");
      expect(today).not.toContain("Yesterday's soup");
      expect(today.match(/<p class="notice">No lunch data<\/p>/g)).toHaveLength(2);
      expect(row(res.body, "2026-10-23")).toContain("No lunch data");
    });

    it("says there is no school lunch on a weekend", async () => {
      const app = await start();
      createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

      const res = await app.inject({ method: "GET", url: "/" });

      expect(row(res.body, "2026-10-24")).toContain("No school lunch");
      expect(row(res.body, "2026-10-24")).not.toContain("No lunch data");
    });

    it("omits paused Schools", async () => {
      const app = await start();
      const paused = createSchool(app.ctx.db, { name: "Paused School", url: "https://paused.example/menu" });
      setSchoolActive(app.ctx.db, paused.id, false);

      const res = await app.inject({ method: "GET", url: "/" });

      expect(res.body).not.toContain("Paused School");
    });
  });

  describe("red days", () => {
    it("renders Sunday red with its weekday text; Saturday stays ink", async () => {
      const app = await start();

      const res = await app.inject({ method: "GET", url: "/" });

      expect(rowTag(res.body, "2026-10-25")).toContain("day-red");
      expect(row(res.body, "2026-10-25")).toMatch(/<b>25<\/b><span>Sun<\/span>/);
      expect(rowTag(res.body, "2026-10-24")).not.toContain("day-red");
    });

    it("renders a public holiday red, with its name, also on a Saturday", async () => {
      const app = await start({ now: () => new Date(2026, 9, 28, 9, 0) });

      const res = await app.inject({ method: "GET", url: "/" });

      expect(rowTag(res.body, "2026-10-31")).toContain("day-red");
      expect(row(res.body, "2026-10-31")).toMatch(/<b>31<\/b><span>Sat<\/span>/);
      expect(row(res.body, "2026-10-31")).toContain("All Saints&#39; Day");
    });
  });

  describe("first run", () => {
    it("asks for a School and Dishes when there are none", async () => {
      const app = await start();

      const res = await app.inject({ method: "GET", url: "/" });

      const block = res.body.match(/<section id="first-run"[\s\S]*?<\/section>/)![0];
      expect(block).toMatch(/<a class="button[^"]*" href="\/schools">Add a School<\/a>/);
      expect(block).toMatch(/<a class="button[^"]*" href="\/dishes\/new">Add dishes<\/a>/);
    });

    it("still appears with Schools but no Dishes, and goes away once both exist", async () => {
      const app = await start();
      createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
      expect((await app.inject({ method: "GET", url: "/" })).body).toContain('id="first-run"');

      createDish(app.ctx.db, { name: "Tacos" });
      expect((await app.inject({ method: "GET", url: "/" })).body).not.toContain('id="first-run"');
    });
  });

  it("labels Uppdatera lunchmenyer with Hämtar menyer… while it works", async () => {
    const app = await start();
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    const res = await app.inject({ method: "GET", url: "/", headers: { cookie: "lang=sv" } });

    expect(res.body).toContain('data-working-label="Hämtar menyer…">Uppdatera lunchmenyer</button>');
  });

  it("offers Refresh lunch menus as a quiet action below the week", async () => {
    const app = await start();
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toMatch(/<\/article>\s*(?:<\/div>\s*)?<form method="post" action="\/lunch\/refresh"><button type="submit" class="quiet" data-working-label="Fetching menus…">Refresh lunch menus<\/button><\/form>/);
  });

  it("renders in Swedish", async () => {
    const app = await start({ now: () => new Date(2026, 9, 28, 9, 0) });
    writeSetting(app.ctx.db, "quick_day_template", JSON.stringify({ wed: 30 }));
    const dishId = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true, recipeUrl: "https://r.example/k", prepTimeMinutes: 30 });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    plan(app, [dinner({ date: "2026-10-28", dishId, isQuickDay: true })], "2026-10-26");

    const res = await app.inject({ method: "GET", url: "/", headers: { cookie: "lang=sv" } });

    expect(res.body).toMatch(/<h1 class="week-num"[^>]*><small>v\.<\/small>44<\/h1>/);
    expect(res.body).toContain('<div class="week-month">oktober 2026</div>');
    const today = row(res.body, "2026-10-28");
    expect(today).toMatch(/<b>28<\/b><span>Ons<\/span>/);
    expect(today).toContain("Lunch · Northside");
    expect(today).toContain("Ingen lunchdata");
    expect(today).toContain("Middag");
    expect(today).toContain("Snabbdag max 30 min");
    expect(today).toContain("Föreslagen");
    expect(today).toContain("Lägg till i favoriter");
    expect(today).toContain(">Byt rätt</a>");
    expect(today).toContain(">Recept</a>");
    expect(row(res.body, "2026-10-29")).toContain("Ingen middag planerad");
    expect(row(res.body, "2026-10-31")).toContain("Alla helgons dag");
    expect(row(res.body, "2026-10-31")).toContain("Ingen skollunch");
    expect(res.body).toContain("Uppdatera lunchmenyer");
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
    expect(row(today.body, TODAY)).toMatch(/<li>Pannkakor<\/li>\s*<li>Ärtsoppa<\/li>/);
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
