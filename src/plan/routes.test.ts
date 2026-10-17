import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish, listDishes } from "../dishes/repo.js";
import {
  NO_AGENT_REASON,
  NoAgent,
  ScriptedLlmAgent,
  type DishSuggestion,
  type SelectDishesInput,
} from "../llm/index.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { NO_ELIGIBLE_DISH_RATIONALE } from "../planner/plan-week.js";
import { confirmPlan, getPlanForWeek, savePlan } from "../planner/repo.js";
import { weekDates } from "../week.js";
import { createSchool } from "../schools/repo.js";
import { createCapturingLogger, type LogRecord } from "../logging/logger.js";

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

describe("GET /plan", () => {
  it("says there is no plan for the current week and offers to generate one", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/plan" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(WEEK);
    expect(res.body).toContain("No plan for this week");
    expect(res.body).toMatch(/<form method="post" action="\/plan\/generate">[\s\S]*name="weekStart" value="2026-10-19"/);
  });

  it("shows all seven days with the dinner's Dish name and rationale, or the no-eligible-dish notice", async () => {
    const app = await start();
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    const dinners = weekDates(WEEK).map((date) => ({
      date,
      dishId: date === "2026-10-22" ? null : burgers,
      isQuickDay: date === "2026-10-20",
      lunchThatDay: null,
      rationale: date === "2026-10-22" ? NO_ELIGIBLE_DISH_RATIONALE : `burgers on ${date}`,
    }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(res.statusCode).toBe(200);
    const days = res.body.match(/<article class="plan-day">/g);
    expect(days).toHaveLength(7);
    for (const date of weekDates(WEEK)) expect(res.body).toContain(`<time datetime="${date}">`);
    expect(res.body).toMatch(/Monday[\s\S]*Tuesday[\s\S]*Wednesday[\s\S]*Thursday[\s\S]*Friday[\s\S]*Saturday[\s\S]*Sunday/);
    expect(res.body.match(/Burgers/g)).toHaveLength(6);
    expect(res.body).toContain("burgers on 2026-10-19");
    expect(res.body).toContain("burgers on 2026-10-25");
    expect(res.body).toContain("No eligible dish, pick one");
    expect(res.body.match(/Quick Day/g)).toHaveLength(1);
    expect(res.body).toContain("Status: generated");
    expect(res.body).not.toContain("No plan for this week");
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
    expect(before.body.match(/Add to favorites/g)).toHaveLength(1);
    expect(before.body).toContain(`action="/dishes/${stew}/promote"`);

    const post = await app.inject({ method: "POST", url: `/dishes/${stew}/promote`, headers: { referer: `/plan?week=${WEEK}` } });
    expect(post.headers.location).toBe(`/plan?week=${WEEK}`);

    const after = await app.inject({ method: "GET", url: post.headers.location as string });
    expect(after.body).toContain("Stew");
    expect(after.body).not.toContain("Suggested");
    expect(after.body).not.toContain("Add to favorites");
  });

  it("renders the badge and button in Swedish", async () => {
    const app = await start();
    const stew = createDish(app.ctx.db, { name: "Stew", inRotation: false, suggested: true });
    const dinners = weekDates(WEEK).map((date) => ({ date, dishId: stew, isQuickDay: false, lunchThatDay: null, rationale: "r" }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: { cookie: "lang=sv" } });

    expect(res.body).toContain("Föreslagen");
    expect(res.body).toContain("Lägg till i favoriter");
  });

  it("shows each School's Lunch Entry for the day, or the no-lunch-data notice (FR-5)", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    createSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: WEEK, rawText: "Pasta bolognese\nFiskgratäng", fetchedAt: NOW.toISOString() });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(res.body).toContain("Northside");
    expect(res.body).toMatch(/<li>Pasta bolognese<\/li>\s*<li>Fiskgratäng<\/li>/);
    // Northside has lunch only on Monday; Southside never: 6 + 7 notices.
    expect(res.body.match(/No lunch data/g)).toHaveLength(13);
  });

  it("shows the plan status and degraded reasons as a notice", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [NO_AGENT_REASON] }, NOW.toISOString());
    confirmPlan(app.ctx.db, WEEK);

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(res.body).toContain("Status: confirmed");
    expect(res.body).toMatch(/<p class="notice">[^<]*no agent configured/);
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

    expect(res.body).toMatch(/<p class="notice">Lunch menu changed since this plan was made: 2026-10-20<\/p>/);
    expect(res.body.match(/Lunch menu changed/g)).toHaveLength(1);
  });

  it("links to the previous and next week and defaults to the week of today", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/plan?week=2026-10-28" });

    expect(res.body).toContain('<time datetime="2026-10-26">');
    expect(res.body).toContain('href="/plan?week=2026-10-19"');
    expect(res.body).toContain('href="/plan?week=2026-11-02"');
    expect((await app.inject({ method: "GET", url: "/plan?week=garbage" })).body).toContain(`<time datetime="${WEEK}">`);
  });
});

describe("POST /plan/generate", () => {
  it("generates the week's plan through the injected agent and redirects to it", async () => {
    const app = await start({ llm: new NoAgent() });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    const res = await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body.match(/Burgers/g)).toHaveLength(7);
    expect(view.body).toContain("no agent configured");
  });

  it("ingests the week's lunch first so the category collision rule applies (FR-4, FR-6b)", async () => {
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: { ok: true, value: [{ date: "2026-10-20", rawText: "Fiskgratäng", mainCategory: "fish" }] },
    });
    const app = await start({ llm, fetchPage: async () => "<html>menu</html>" });
    const fish = createDish(app.ctx.db, { name: "Fish and chips", mainCategory: "fish", prepTimeMinutes: 20 });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    const dinners = getPlanForWeek(app.ctx.db, WEEK)!.dinners;
    const tuesday = dinners.find((d) => d.date === "2026-10-20")!.dishId;
    expect(tuesday).not.toBe(fish); // the seed fallback fills the colliding day instead
    expect(listDishes(app.ctx.db).find((d) => d.id === tuesday)?.mainCategory).not.toBe("fish");
    expect(dinners.find((d) => d.date === "2026-10-21")?.dishId).toBe(fish);
  });

  it("does not raise the lunch-changed notice when its ingest overwrites a stored entry (regenerate only)", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    const north = createSchool(app.ctx.db, { name: "Northside", url: MENU_URL });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Pasta bolognese", fetchedAt: NOW.toISOString() });

    const res = await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
  });

  it("does not replace a confirmed plan and says so (FR-9a)", async () => {
    const app = await start({ llm: new NoAgent() });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    confirmPlan(app.ctx.db, WEEK);

    const res = await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body).not.toContain("Burgers");
    expect(view.body).toContain("confirmed");
    expect(view.body).toContain("was not replaced");
  });
});

describe("POST /plan/generate with Suggested Dishes", () => {
  /** An agent that suggests the same new Dish for every date of the request. */
  function suggestEveryDay(suggestion: DishSuggestion) {
    return new ScriptedLlmAgent({
      selectDishes: (input: SelectDishesInput) => ({
        ok: true,
        value: input.days.map((d) => ({ date: d.date, suggestion, rationale: "something new" })),
      }),
    });
  }

  it("stores a suggestion on an empty rotation as a Suggested Dish the Planned Dinners point at", async () => {
    const app = await start({ llm: suggestEveryDay({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 }) });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    const dishes = listDishes(app.ctx.db);
    expect(dishes).toEqual([
      expect.objectContaining({
        name: "Kalops",
        mainCategory: "beef",
        prepTimeMinutes: 20,
        recipeUrl: null,
        inRotation: false,
        suggested: true,
      }),
    ]);
    const dinners = getPlanForWeek(app.ctx.db, WEEK)!.dinners;
    expect(dinners.map((d) => d.dishId)).toEqual(Array(7).fill(dishes[0]!.id));
  });

  it("reuses the Suggested Dish on a second generate with the same suggestion name", async () => {
    const app = await start({ llm: suggestEveryDay({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 }) });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    const [kalops] = listDishes(app.ctx.db);

    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });

    expect(listDishes(app.ctx.db).map((d) => d.id)).toEqual([kalops!.id]);
    expect(getPlanForWeek(app.ctx.db, WEEK)!.dinners.map((d) => d.dishId)).toEqual(Array(7).fill(kalops!.id));
  });

  it("logs a dropped suggestion and the seed fallback in the planner warn record, storing the seed as a Suggested Dish", async () => {
    const { logger, records } = createCapturingLogger();
    const app = await start({ logger, llm: suggestEveryDay({ name: "Mystery", mainCategory: "not-a-category" }) });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

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
    const llm = suggestEveryDay({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 20 });
    const app = await start({ llm });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    const [kalops] = listDishes(app.ctx.db);

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: "2026-10-26" } });

    const requests = llm.calls.filter((c) => c.method === "selectDishes").map((c) => c.args[0] as SelectDishesInput);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.recentlyPlanned).toEqual([{ dishId: String(kalops!.id), name: "Kalops", lastDate: "2026-10-25" }]);
  });
});

describe("POST /plan/confirm (FR-9a)", () => {
  it("offers a Confirm button on a generated plan, locks it, and says so", async () => {
    const app = await start();
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    const before = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(before.body).toMatch(/<form method="post" action="\/plan\/confirm">[\s\S]*name="weekStart" value="2026-10-19"/);

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
    expect(before.body).toMatch(/<form method="post" action="\/plan\/regenerate">[\s\S]*name="weekStart" value="2026-10-19"/);

    const res = await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body.match(/Burgers/g)).toHaveLength(7);
    expect(view.body).toContain("<li>Fiskgratäng</li>");
    expect(view.body).not.toContain("Lunch menu changed");
  });

  it("shows which stored Lunch Entries changed since the plan was made", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    const north = createSchool(app.ctx.db, { name: "Northside", url: MENU_URL });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Pasta bolognese", fetchedAt: NOW.toISOString() });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());

    const res = await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body).toMatch(/<p class="notice">Lunch menu changed since this plan was made: Northside 2026-10-20<\/p>/);
  });

  it("asks for confirmation before replacing a confirmed plan, then replaces it on override (FR-9a)", async () => {
    const app = await start({ llm: new NoAgent(), fetchPage: fetchMenu });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: emptyDinners(), degradedReasons: [] }, NOW.toISOString());
    confirmPlan(app.ctx.db, WEEK);

    const ask = await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });

    expect(ask.statusCode).toBe(200);
    expect(ask.body).toContain("This plan is confirmed");
    expect(ask.body).toMatch(/<form method="post" action="\/plan\/regenerate">[\s\S]*name="weekStart" value="2026-10-19"[\s\S]*name="confirmed_override" value="1"/);
    const untouched = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(untouched.body).not.toContain("Burgers");
    expect(untouched.body).toContain("Status: confirmed");

    const res = await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK, confirmed_override: "1" } });

    expect(res.statusCode).toBe(303);
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    expect(view.body.match(/Burgers/g)).toHaveLength(7);
    expect(view.body).toContain("Status: generated");
  });
});

function emptyDinners() {
  return weekDates(WEEK).map((date) => ({
    date,
    dishId: null,
    isQuickDay: false,
    lunchThatDay: null,
    rationale: NO_ELIGIBLE_DISH_RATIONALE,
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

    await app.inject({ method: "POST", url, payload: { weekStart: WEEK } });

    const run = runRecords(records, url);
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "run started", component: "plan", weekStart: WEEK }));
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "run finished", component: "plan", weekStart: WEEK }));
  });
});
