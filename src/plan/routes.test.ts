import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NO_AGENT_REASON, NoAgent } from "../llm/index.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { NO_ELIGIBLE_DISH_RATIONALE } from "../planner/plan-week.js";
import { confirmPlan, savePlan } from "../planner/repo.js";
import { weekDates } from "../week.js";
import { createSchool } from "../schools/repo.js";

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
