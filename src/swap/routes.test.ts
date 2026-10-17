import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { confirmPlan, getPlanForWeek, savePlan } from "../planner/repo.js";
import { createSchool } from "../schools/repo.js";
import { weekDates } from "../week.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19. Tuesday is a Quick Day (30 min) by default.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const MONDAY = "2026-10-19";
const TUESDAY = "2026-10-20";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-swap-"));
  const app = await buildApp({ dataDir, now: () => NOW, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** The planned week with `dishId` on every day. */
function planWeek(app: Awaited<ReturnType<typeof buildApp>>, dishId: number) {
  const dinners = weekDates(WEEK).map((date) => ({ date, dishId, isQuickDay: date === TUESDAY, lunchThatDay: null, rationale: "planned" }));
  savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());
}

describe("GET /plan/swap", () => {
  it("lists only the Dishes eligible on that date", async () => {
    const app = withEnglish(await start());
    const db = app.ctx.db;
    const school = createSchool(db, { name: "Northside", url: "https://north.example/menu" });
    upsertLunchEntry(db, { schoolId: school.id, date: MONDAY, rawText: "Fiskgratäng", mainCategory: "fish", fetchedAt: NOW.toISOString() });
    const burgers = createDish(db, { name: "Burgers", mainCategory: "beef", prepTimeMinutes: 45 });
    createDish(db, { name: "Salmon", mainCategory: "fish", prepTimeMinutes: 20 });
    createDish(db, { name: "Pizza", mainCategory: "vegetarian", prepTimeMinutes: 25 });
    createDish(db, { name: "Roast", mainCategory: "beef", prepTimeMinutes: 20, weekendOnly: true });
    createDish(db, { name: "Pancakes", mainCategory: "vegetarian", prepTimeMinutes: 15 });
    planWeek(app, burgers);

    const monday = await app.inject({ method: "GET", url: `/plan/swap?date=${MONDAY}`, headers: { "hx-request": "true" } });
    expect(monday.statusCode).toBe(200);
    expect(monday.body).toContain("Pizza");
    expect(monday.body).toContain("Pancakes");
    expect(monday.body).not.toContain("Salmon"); // same Main Category as lunch
    expect(monday.body).not.toContain("Roast"); // Weekend Dish on a weekday
    expect(monday.body).not.toContain("<html"); // an HTMX fragment

    const tuesday = await app.inject({ method: "GET", url: `/plan/swap?date=${TUESDAY}`, headers: { "hx-request": "true" } });
    expect(tuesday.body).toContain("Salmon");
    expect(tuesday.body).not.toContain("Burgers"); // 45 min on a 30 min Quick Day
  });
});

/** The almanac row for `date`, or a thrown error when the page has none. */
function row(body: string, date: string): string {
  const m = body.match(new RegExp(`<article[^>]*id="day-${date}"[\\s\\S]*?</article>`));
  if (!m) throw new Error(`no row for ${date}`);
  return m[0];
}

describe("POST /plan/swap", () => {
  it.each([
    ["en", "chosen by hand"],
    ["sv", "vald för hand"],
  ])("writes the picked Dish with the %s by-hand rationale and rebuilds the Shopping List", async (lang, rationale) => {
    const app = await start();
    const db = app.ctx.db;
    const cookie = `lang=${lang}`;
    const burgers = createDish(db, { name: "Burgers", ingredients: [{ name: "minced beef", quantity: 500, unit: "g" }] });
    const pizza = createDish(db, { name: "Pizza", ingredients: [{ name: "mozzarella", quantity: 2, unit: "st" }] });
    planWeek(app, burgers);
    await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie } });

    const res = await app.inject({
      method: "POST",
      url: "/plan/swap",
      headers: { cookie },
      payload: { date: MONDAY, dishId: String(pizza), next: `/plan?week=${WEEK}` },
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const plan = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: { cookie } });
    expect(row(plan.body, MONDAY)).toContain('<div class="day-dinner">Pizza</div>');
    expect(row(plan.body, MONDAY)).toContain(`<p class="why">${rationale}</p>`);
    expect(row(plan.body, TUESDAY)).toContain('<div class="day-dinner">Burgers</div>');
    const shopping = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie } });
    expect(shopping.body).toContain("mozzarella");
  });

  it("clears the swapped day's degraded notice and keeps the others", async () => {
    const app = withEnglish(await start());
    const db = app.ctx.db;
    const burgers = createDish(db, { name: "Burgers" });
    const pizza = createDish(db, { name: "Pizza" });
    const dinners = weekDates(WEEK).map((date) => ({ date, dishId: burgers, isQuickDay: false, lunchThatDay: null, rationale: "planned" }));
    const degradedReasons = [
      { code: "seed-fallback" as const, date: MONDAY },
      { code: "seed-fallback" as const, date: TUESDAY },
      { code: "no-agent" as const, date: null },
    ];
    savePlan(db, { weekStart: WEEK, dinners, degradedReasons }, NOW.toISOString());
    const before = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(row(before.body, MONDAY)).toContain('class="notice"');

    await app.inject({ method: "POST", url: "/plan/swap", payload: { date: MONDAY, dishId: String(pizza) } });

    const plan = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(row(plan.body, MONDAY)).not.toContain('class="notice"');
    expect(row(plan.body, TUESDAY)).toContain('class="notice"');
    expect(getPlanForWeek(db, WEEK)?.degradedReasons).toEqual([
      { code: "seed-fallback", date: TUESDAY },
      { code: "no-agent", date: null },
    ]);
  });

  it("rejects a Dish that is not eligible on that date", async () => {
    const app = withEnglish(await start());
    const burgers = createDish(app.ctx.db, { name: "Burgers" });
    const roast = createDish(app.ctx.db, { name: "Roast", weekendOnly: true });
    planWeek(app, burgers);

    const res = await app.inject({ method: "POST", url: "/plan/swap", payload: { date: MONDAY, dishId: String(roast) } });

    expect(res.statusCode).toBe(400);
    const plan = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(row(plan.body, MONDAY)).toContain("Burgers");
  });
});

describe("Byt on Plan and Today", () => {
  it("offers Byt on every planned day of Plan and on today's row, loading the date's list in place", async () => {
    const app = withEnglish(await start());
    planWeek(app, createDish(app.ctx.db, { name: "Burgers" }));

    const plan = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    for (const date of weekDates(WEEK)) {
      expect(row(plan.body, date)).toMatch(new RegExp(`<div class="actions"><a class="button" href="/plan/swap\\?date=${date}&amp;next=%2Fplan%3Fweek%3D${WEEK}" hx-get="[^"]+" hx-target="this" hx-swap="outerHTML">Swap dish</a>`));
    }

    const today = await app.inject({ method: "GET", url: "/" });
    expect(row(today.body, "2026-10-21")).toContain('href="/plan/swap?date=2026-10-21&amp;next=%2F"');
    expect(today.body).not.toContain("disabled>Swap dish");
  });

  it("hides Byt and refuses the Swap on a confirmed plan", async () => {
    const app = withEnglish(await start());
    const burgers = createDish(app.ctx.db, { name: "Burgers" });
    const pizza = createDish(app.ctx.db, { name: "Pizza" });
    planWeek(app, burgers);
    confirmPlan(app.ctx.db, WEEK);

    const plan = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    const today = await app.inject({ method: "GET", url: "/" });
    expect(plan.body).not.toContain("Swap dish");
    expect(today.body).not.toContain("Swap dish");
    const list = await app.inject({ method: "GET", url: `/plan/swap?date=${MONDAY}` });
    expect(list.statusCode).toBe(409);
    const post = await app.inject({ method: "POST", url: "/plan/swap", payload: { date: MONDAY, dishId: String(pizza) } });
    expect(post.statusCode).toBe(409);
    expect(post.body).toContain("can't be swapped");
    expect(row((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body, MONDAY)).toContain("Burgers");
  });

  it("hides Byt and refuses the Swap while the week's Plan Run is in flight", async () => {
    const app = withEnglish(await start());
    const pizza = createDish(app.ctx.db, { name: "Pizza" });
    planWeek(app, createDish(app.ctx.db, { name: "Burgers" }));
    app.ctx.planRuns.start(WEEK, { runId: "r1", startedAt: NOW });

    const plan = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(plan.body).not.toContain("Swap dish");
    const post = await app.inject({ method: "POST", url: "/plan/swap", payload: { date: MONDAY, dishId: String(pizza) } });
    expect(post.statusCode).toBe(409);
  });

  it("opens the list as a page without JavaScript, in Swedish", async () => {
    const app = await start();
    planWeek(app, createDish(app.ctx.db, { name: "Burgers" }));
    createDish(app.ctx.db, { name: "Pizza" });

    const res = await app.inject({ method: "GET", url: `/plan/swap?date=${MONDAY}&next=/`, headers: { cookie: "lang=sv" } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<html");
    expect(res.body).toContain("Välj en rätt för dagen");
    expect(res.body).toMatch(/<button type="submit" class="row" name="dishId" value="\d+"><span class="row-label">Pizza<\/span>/);
    expect(res.body).not.toContain(">Burgers<"); // the current Dish
    expect(res.body).toContain('<input type="hidden" name="next" value="/" />');
  });
});
