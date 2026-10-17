import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish, listDishes } from "../dishes/repo.js";
import {
  NoAgent,
  ScriptedLlmAgent,
  type DishSuggestion,
  type SelectDishesInput,
} from "../llm/index.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { confirmPlan, getPlanForWeek, savePlan } from "../planner/repo.js";
import { weekDates } from "../week.js";
import { createSchool } from "../schools/repo.js";
import { createCapturingLogger, type LogRecord } from "../logging/logger.js";
import { postPlanRun } from "../plan-run/test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-plan-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** The almanac row for `date`, or a thrown error when the page has none. */
function row(body: string, date: string): string {
  const m = body.match(new RegExp(`<article[^>]*id="day-${date}"[\\s\\S]*?</article>`));
  if (!m) throw new Error(`no row for ${date}`);
  return m[0];
}

/** The page up to the first almanac row: week head, navigation, status and controls. */
const top = (body: string) => body.slice(0, body.indexOf("<article"));

describe("GET /plan", () => {
  it("says there is no plan for the week and offers to generate one, above the week's rows", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/plan" });

    expect(res.statusCode).toBe(200);
    expect(top(res.body)).toContain("No plan for this week");
    expect(top(res.body)).toMatch(/<form method="post" action="\/plan\/generate"[^>]*>[\s\S]*name="weekStart" value="2026-10-19"/);
    for (const date of weekDates(WEEK)) expect(row(res.body, date)).toContain("No plan");
  });

  it("opens all seven days with Dish, minutes, Quick Day tag, rationale and Byt, or the no-eligible-dish notice", async () => {
    const app = await start();
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    const dinners = weekDates(WEEK).map((date) => ({
      date,
      dishId: date === "2026-10-22" ? null : burgers,
      isQuickDay: date === "2026-10-20",
      lunchThatDay: null,
      rationale: date === "2026-10-22" ? "Ingen lämplig rätt, välj en." : `burgers on ${date}`,
    }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(res.statusCode).toBe(200);
    expect(res.body.match(/<article class="day day-full/g)).toHaveLength(7);
    const monday = row(res.body, "2026-10-19");
    expect(monday).toContain("Mon");
    expect(monday).toContain('<div class="day-dinner">Burgers</div>');
    expect(monday).toContain("20 min");
    expect(monday).toContain('<p class="why">burgers on 2026-10-19</p>');
    expect(monday).toMatch(/<a class="button" href="\/plan\/swap\?date=2026-10-19[^"]*"[^>]*>Swap dish<\/a>/);
    expect(row(res.body, "2026-10-25")).toContain("burgers on 2026-10-25");
    expect(row(res.body, "2026-10-20")).toContain("Quick Day");
    expect(res.body.match(/Quick Day/g)).toHaveLength(1);
    expect(row(res.body, "2026-10-22")).toContain("No eligible dish, pick one");
    expect(top(res.body)).toContain("Status: generated");
    expect(res.body).not.toContain("No plan for this week");
  });

  it("marks today's row when the shown week holds today", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(row(res.body, "2026-10-21")).toMatch(/^<article[^>]*aria-current="date"/);
    expect(res.body.match(/aria-current="date"/g)).toHaveLength(1);
  });

  it("marks only Suggested Dishes and promotes from Plan, returning to Plan with the badge gone", async () => {
    const app = await start();
    const burgers = createDish(app.ctx.db, { name: "Burgers" });
    const stew = createDish(app.ctx.db, { name: "Stew", inRotation: false, suggested: true });
    const dinners = weekDates(WEEK).map((date) => ({
      date,
      dishId: date === "2026-10-21" ? stew : burgers,
      isQuickDay: false,
      lunchThatDay: null,
      rationale: "r",
    }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());

    const before = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(before.body.match(/Suggested/g)).toHaveLength(1);
    expect(row(before.body, "2026-10-21")).toContain("Add to favorites");
    expect(before.body.match(/Add to favorites/g)).toHaveLength(1);
    expect(before.body).toContain(`action="/dishes/${stew}/promote"`);

    const post = await app.inject({ method: "POST", url: `/dishes/${stew}/promote`, headers: { referer: `/plan?week=${WEEK}` } });
    expect(post.headers.location).toBe(`/plan?week=${WEEK}`);

    const after = await app.inject({ method: "GET", url: post.headers.location as string });
    expect(after.body).toContain("Stew");
    expect(after.body).not.toContain("Suggested");
    expect(after.body).not.toContain("Add to favorites");
  });

  it("renders the review page in Swedish", async () => {
    const app = await start();
    const stew = createDish(app.ctx.db, { name: "Stew", inRotation: false, suggested: true, prepTimeMinutes: 25 });
    const dinners = weekDates(WEEK).map((date) => ({ date, dishId: stew, isQuickDay: date === "2026-10-20", lunchThatDay: null, rationale: "r" }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: { cookie: "lang=sv" } });

    expect(res.body).toContain('aria-label="Vecka 43"');
    expect(top(res.body)).toMatch(/<span aria-hidden="true">‹<\/span> v\. 42/);
    expect(top(res.body)).toMatch(/v\. 44 <span aria-hidden="true">›<\/span>/);
    expect(top(res.body)).toContain("Status: genererad");
    expect(top(res.body)).toContain("Bekräfta planen");
    expect(top(res.body)).toContain("Generera planen igen");
    const tuesday = row(res.body, "2026-10-20");
    expect(tuesday).toContain("Tis");
    expect(tuesday).toContain("Middag");
    expect(tuesday).toContain("Snabbdag");
    expect(tuesday).toContain("Byt rätt");
    expect(tuesday).toContain("Föreslagen");
    expect(tuesday).toContain("Lägg till i favoriter");
  });

  it("shows each School's Lunch Entry for the day, or the no-lunch-data block (FR-5)", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    createSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: WEEK, rawText: "Pasta bolognese\nFiskgratäng", fetchedAt: NOW.toISOString() });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    const monday = row(res.body, WEEK);
    expect(monday).toContain("Lunch · Northside");
    expect(monday).toMatch(/<li>Pasta bolognese<\/li>\s*<li>Fiskgratäng<\/li>/);
    expect(monday).toContain("Lunch · Southside");
    expect(monday).toMatch(/class="notice"[^>]*>[\s\S]*No lunch data/);
    // Northside has lunch only on Monday, Southside never: 1 + 2 × 4 weekday blocks. The weekend says so.
    expect(res.body.match(/No lunch data/g)).toHaveLength(9);
    expect(row(res.body, "2026-10-24")).toContain("No school lunch");
  });

  it("shows the plan status and week-wide degraded reasons as a notice above the days", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [{ code: "no-agent", date: null }] }, NOW.toISOString());
    confirmPlan(app.ctx.db, WEEK);

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(top(res.body)).toContain("Status: confirmed");
    expect(top(res.body)).toMatch(/<div class="notice" role="alert">[\s\S]*No agent is set up, so the dishes were picked automatically./);
  });

  it("warns when a day's Lunch Entry no longer matches what the plan was made with (Q17)", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-19", rawText: "Pasta bolognese", fetchedAt: NOW.toISOString() });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Fiskgratäng", fetchedAt: NOW.toISOString() });
    const dinners = emptyDinners().map((d) => ({
      ...d,
      lunchThatDay: d.date === "2026-10-19" ? "Pasta bolognese" : d.date === "2026-10-20" ? "Köttbullar" : null,
    }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(top(res.body)).toContain('<span class="notice-text">Lunch menu changed since this plan was made: 2026-10-20</span>');
    expect(res.body.match(/Lunch menu changed/g)).toHaveLength(1);
  });

  it("navigates by ISO week number to the previous and next week", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/plan?week=2026-10-28" });

    expect(res.body).toContain('aria-label="Week 44"');
    expect(row(res.body, "2026-10-26")).toContain('<time datetime="2026-10-26">');
    expect(top(res.body)).toMatch(/<a href="\/plan\?week=2026-10-19" rel="prev"[^>]*><span aria-hidden="true">‹<\/span> wk 43<\/a>/);
    expect(top(res.body)).toMatch(/<a href="\/plan\?week=2026-11-02" rel="next"[^>]*>wk 45 <span aria-hidden="true">›<\/span><\/a>/);
    expect((await app.inject({ method: "GET", url: "/plan?week=garbage" })).body).toContain(`id="day-${WEEK}"`);
  });

  it("numbers the weeks across a year boundary", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/plan?week=2026-12-28" });

    expect(res.body).toContain('aria-label="Week 53"');
    expect(top(res.body)).toContain("</span> wk 52</a>");
    expect(top(res.body)).toContain("wk 1 <span");
  });
});

describe("GET /plan default week", () => {
  const NEXT = "2026-10-26";

  it("opens on next week once a Weekly Plan exists for it", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    savePlan(app.ctx.db, { weekStart: NEXT, dinners: [], degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: "/plan" });

    expect(res.body).toContain('id="day-2026-10-26"');
    expect(res.body).not.toContain('id="day-2026-10-19"');
  });

  it("opens on this week while next week has no plan", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/plan" });

    expect(res.body).toContain('id="day-2026-10-19"');
    expect(res.body).not.toContain('id="day-2026-10-26"');
  });

  it("keeps an explicit week even when next week has a plan", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: NEXT, dinners: [], degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(res.body).toContain('id="day-2026-10-21"');
  });
});

describe("POST /plan/generate", () => {
  it("generates the week's plan through the injected agent and redirects to it", async () => {
    const app = await start({ llm: new NoAgent() });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    const res = await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body.match(/Burgers(?! is already planned this week)/g)).toHaveLength(1); // Once a Week
    expect(view.body).toContain("Burgers is already planned this week, so it was left out.");
    expect(view.body).toContain("Picked automatically; no agent is set up.");
  });

  it("ingests the week's lunch first so the category collision rule applies (FR-4, FR-6b)", async () => {
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: { ok: true, value: [{ date: "2026-10-20", rawText: "Fiskgratäng", mainCategory: "fish" }] },
    });
    const app = await start({ llm, fetchPage: async () => "<html>menu</html>" });
    const fish = createDish(app.ctx.db, { name: "Fish and chips", mainCategory: "fish", prepTimeMinutes: 20 });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const dinners = getPlanForWeek(app.ctx.db, WEEK)!.dinners;
    const tuesday = dinners.find((d) => d.date === "2026-10-20")!.dishId;
    expect(tuesday).not.toBe(fish); // the seed fallback fills the colliding day instead
    expect(listDishes(app.ctx.db).find((d) => d.id === tuesday)?.mainCategory).not.toBe("fish");
    expect(dinners.find((d) => d.date === "2026-10-19")?.dishId).toBe(fish);
  });

  it("does not raise the lunch-changed notice when its ingest overwrites a stored entry (regenerate only)", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    const north = createSchool(app.ctx.db, { name: "Northside", url: MENU_URL });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Pasta bolognese", fetchedAt: NOW.toISOString() });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).not.toContain("Lunch menu changed");
  });

  it("does not replace a confirmed plan and says so (FR-9a)", async () => {
    const app = await start({ llm: new NoAgent() });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    confirmPlan(app.ctx.db, WEEK);

    const res = await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    expect(res.statusCode).toBe(303);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body).not.toContain("Burgers");
    expect(view.body).toContain("confirmed");
    expect(view.body).toContain("was not replaced");
  });
});

describe("POST /plan/generate Ingredient language", () => {
  it("asks the agent for the week's Ingredients in the household's UI language", async () => {
    const llm = new ScriptedLlmAgent({
      selectDishes: { ok: false, reason: "offline" },
      findRecipe: { ok: true, value: { url: "https://recipes.example/burgers", ingredients: [{ name: "minced beef" }] } },
    });
    const app = await start({ llm });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const finds = llm.calls.filter((c) => c.method === "findRecipe");
    expect(finds.length).toBeGreaterThan(0);
    expect(finds.map((c) => (c.args[1] as { language?: string }).language)).toEqual(finds.map(() => "en"));
  });
});

describe("POST /plan/generate with Suggested Dishes", () => {
  /** An agent that suggests one new Dish, on the first date of the request; the seed list fills the rest (Once a Week). */
  function suggestOnMonday(suggestion: DishSuggestion) {
    return new ScriptedLlmAgent({
      selectDishes: (input: SelectDishesInput) => ({
        ok: true,
        value: input.days.slice(0, 1).map((d) => ({ date: d.date, suggestion, rationale: "something new" })),
      }),
    });
  }

  it("stores a suggestion on an empty rotation as a Suggested Dish the Planned Dinners point at", async () => {
    const app = await start({ llm: suggestOnMonday({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 }) });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const dishes = listDishes(app.ctx.db);
    const kalops = dishes.find((d) => d.name === "Kalops");
    expect(kalops).toEqual(
      expect.objectContaining({
        name: "Kalops",
        mainCategory: "beef",
        prepTimeMinutes: 20,
        recipeUrl: null,
        inRotation: false,
        suggested: true,
      }),
    );
    const dinners = getPlanForWeek(app.ctx.db, WEEK)!.dinners;
    expect(dinners[0]!.dishId).toBe(kalops!.id);
  });

  it("reuses the Suggested Dish on a second generate with the same suggestion name", async () => {
    const app = await start({ llm: suggestOnMonday({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 }) });
    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });
    const before = listDishes(app.ctx.db).map((d) => d.id);
    const kalops = listDishes(app.ctx.db).find((d) => d.name === "Kalops");

    await postPlanRun(app, "/plan/regenerate", { weekStart: WEEK });

    expect(listDishes(app.ctx.db).map((d) => d.id)).toEqual(before);
    expect(getPlanForWeek(app.ctx.db, WEEK)!.dinners[0]!.dishId).toBe(kalops!.id);
  });

  it("logs a dropped suggestion and the seed fallback in the planner warn record, storing the seed as a Suggested Dish", async () => {
    const { logger, records } = createCapturingLogger();
    const app = await start({ logger, llm: suggestOnMonday({ name: "Mystery", mainCategory: "not-a-category" }) });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const warn = records.find((r) => r.level === "warn" && r.component === "planner");
    const reasons = warn?.degradedReasons as string[];
    expect(reasons).toContainEqual(expect.stringMatching(/^2026-10-19: suggestion "Mystery" dropped: /));
    expect(reasons).toContain("2026-10-19: seed fallback used");
    const dishes = listDishes(app.ctx.db);
    expect(dishes.map((d) => d.name)).not.toContain("Mystery");
    expect(dishes.length).toBeGreaterThan(0);
    expect(dishes.every((d) => d.suggested && !d.inRotation)).toBe(true);
    const mondayDishId = getPlanForWeek(app.ctx.db, WEEK)!.dinners[0]!.dishId;
    expect(dishes.map((d) => d.id)).toContain(mondayDishId);
  });

  it("passes last week's Suggested Dish to the next generate as recently planned (variety)", async () => {
    const llm = suggestOnMonday({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 });
    const app = await start({ llm });
    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });
    const kalops = listDishes(app.ctx.db).find((d) => d.name === "Kalops");

    await postPlanRun(app, "/plan/generate", { weekStart: "2026-10-26" });

    const requests = llm.calls.filter((c) => c.method === "selectDishes").map((c) => c.args[0] as SelectDishesInput);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.recentlyPlanned).toContainEqual({ dishId: String(kalops!.id), name: "Kalops", lastDate: "2026-10-19" });
  });
});

describe("POST /plan/confirm (FR-9a)", () => {
  it("offers a Confirm button on a generated plan, locks it, and says so", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    const before = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(before.body).toMatch(/<form method="post" action="\/plan\/confirm"[^>]*>[\s\S]*name="weekStart" value="2026-10-19"/);

    const res = await app.inject({ method: "POST", url: "/plan/confirm", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}&notice=plan-confirmed`);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body).toContain("Status: confirmed");
    expect(view.body).toContain("Plan confirmed");
    expect(view.body).not.toContain('action="/plan/confirm"');
  });
});

const MENU_URL = "https://north.example/menu.lunch.json";
const MENU_PAGE = JSON.stringify({ days: [{ date: "2026-10-20", dishes: ["Fiskgratäng"] }] });
const fetchMenu = async (url: string) => {
  if (url !== MENU_URL) throw new Error(`no fixture for ${url}`);
  return MENU_PAGE;
};

describe("POST /plan/regenerate (FR-9, Q17)", () => {
  it("re-checks the school menus, replaces the plan, and offers a Regenerate button on the plan view", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    createSchool(app.ctx.db, { name: "Northside", url: MENU_URL });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    const before = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(before.body).toMatch(/<form method="post" action="\/plan\/regenerate"[^>]*>[\s\S]*name="weekStart" value="2026-10-19"/);

    const res = await postPlanRun(app, "/plan/regenerate", { weekStart: WEEK });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body.match(/Burgers(?! is already planned this week)/g)).toHaveLength(1); // Once a Week
    expect(view.body).toContain("Burgers is already planned this week, so it was left out.");
    expect(view.body).toContain("<li>Fiskgratäng</li>");
    expect(view.body).not.toContain("Lunch menu changed");
  });

  it("shows which stored Lunch Entries changed since the plan was made", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    const north = createSchool(app.ctx.db, { name: "Northside", url: MENU_URL });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Pasta bolognese", fetchedAt: NOW.toISOString() });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());

    const res = await postPlanRun(app, "/plan/regenerate", { weekStart: WEEK });

    expect(res.statusCode).toBe(303);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body).toMatch(/<p class="notice">Lunch menu changed since this plan was made: Northside 2026-10-20<\/p>/);
  });

  it("asks for confirmation before replacing a confirmed plan, then replaces it on override (FR-9a)", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    confirmPlan(app.ctx.db, WEEK);

    const ask = await postPlanRun(app, "/plan/regenerate", { weekStart: WEEK });

    expect(ask.statusCode).toBe(200);
    expect(ask.body).toContain("This plan is confirmed");
    expect(ask.body).toMatch(/<form method="post" action="\/plan\/regenerate"[^>]*>[\s\S]*name="weekStart" value="2026-10-19"[\s\S]*name="confirmed_override" value="1"/);
    const untouched = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(untouched.body).not.toContain("Burgers");
    expect(untouched.body).toContain("Status: confirmed");

    const res = await postPlanRun(app, "/plan/regenerate", { weekStart: WEEK, confirmed_override: "1" });

    expect(res.statusCode).toBe(303);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body.match(/Burgers(?! is already planned this week)/g)).toHaveLength(1); // Once a Week
    expect(view.body).toContain("Burgers is already planned this week, so it was left out.");
    expect(view.body).toContain("Status: generated");
  });
});

function emptyDinners() {
  return weekDates(WEEK).map((date) => ({
    date,
    dishId: null,
    isQuickDay: false,
    lunchThatDay: null,
    rationale: "Ingen lämplig rätt, välj en.",
  }));
}

describe("run logging", () => {
  /** The records of the one request to `url`, found by the runId on its "request completed" line. */
  function runRecords(records: LogRecord[], url: string): LogRecord[] {
    const runId = records.find((r) => r.msg === "request completed" && r.url === url)?.runId;
    expect(runId).toEqual(expect.any(String));
    return records.filter((r) => r.runId === runId);
  }

  it.each(["/plan/generate", "/plan/regenerate"])("%s logs run started and finished with runId = request id", async (url) => {
    const { logger, records } = createCapturingLogger();
    const app = await start({ logger, llm: new NoAgent() });

    await postPlanRun(app, url, { weekStart: WEEK });

    const run = runRecords(records, url);
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "run started", component: "plan", weekStart: WEEK }));
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "run finished", component: "plan", weekStart: WEEK }));
  });

  it.each(["/plan/generate", "/plan/regenerate"])("%s logs each Phase of the Plan Run in order, with per-Dish progress during Ingredient resolution", async (url) => {
    const { logger, records } = createCapturingLogger();
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({
        ok: true,
        value: input.days.map((d, i) => ({ date: d.date, dishId: String(dishes[i]), rationale: "r" })),
      }),
      findRecipe: { ok: true, value: { url: "https://recipes.example/x", ingredients: [{ name: "Beef" }] } },
    });
    const app = await start({ logger, llm });
    const names = ["Burgers", "Kalops", "Pasta", "Soup", "Tacos", "Curry", "Stew"];
    const dishes = names.map((name) => createDish(app.ctx.db, { name, prepTimeMinutes: 20 }));

    await postPlanRun(app, url, { weekStart: WEEK });

    const planRun = runRecords(records, url).filter((r) => r.component === "plan-run");
    expect(planRun.every((r) => r.level === "info" && r.weekStart === WEEK)).toBe(true);
    expect(planRun.filter((r) => r.msg === "phase").map((r) => r.phase)).toEqual([
      "lunch-ingest",
      "dish-selection",
      "ingredient-resolution",
      "pantry-matching",
      "shopping-list-push",
    ]);
    const progress = planRun.filter((r) => r.msg === "phase progress");
    expect(progress.map((r) => [r.phase, r.done, r.total, r.dish])).toEqual(names.map((name, i) => ["ingredient-resolution", i, 7, name]));
    // Progress belongs between its Phase record and the next one.
    const order = planRun.map((r) => (r.msg === "phase" ? r.phase : "progress"));
    expect(order.indexOf("ingredient-resolution")).toBeLessThan(order.indexOf("progress"));
    expect(order.lastIndexOf("progress")).toBeLessThan(order.indexOf("pantry-matching"));
  });
});
