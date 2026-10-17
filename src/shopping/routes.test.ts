import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent, type FoundRecipe, type LlmResult } from "../llm/index.js";
import { createPantryItem, listPantryItems } from "../pantry/repo.js";
import { savePlan } from "../planner/repo.js";
import { planRunSettled, postPlanRun } from "../plan-run/test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-shopping-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, llm: new NoAgent(), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function planWith(app: Awaited<ReturnType<typeof buildApp>>, dishIds: number[]) {
  return savePlan(
    app.ctx.db,
    {
      weekStart: WEEK,
      dinners: dishIds.map((dishId, i) => ({
        date: `2026-10-${19 + i}`,
        dishId,
        isQuickDay: false,
        lunchThatDay: null,
        rationale: "r",
      })),
      degradedReasons: [],
    },
    NOW.toISOString(),
  );
}

describe("POST /shopping/pantry", () => {
  it("creates a Pantry Item from a Buy line and moves it to Check pantry", async () => {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "tomat", quantity: 2, unit: null }] });
    planWith(app, [pasta]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    const before = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(before.body).toMatch(/<section id="buy">[\s\S]*action="\/shopping\/pantry"[\s\S]*name="name" value="pasta"/);
    expect(before.body).not.toMatch(/<section id="check-pantry">[\s\S]*pasta/);

    const res = await app.inject({ method: "POST", url: "/shopping/pantry", payload: { weekStart: WEEK, name: "pasta" } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/shopping?week=${WEEK}`);
    expect(listPantryItems(app.ctx.db).map((p) => p.name)).toEqual(["pasta"]);
    const after = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(after.body).toMatch(/<section id="check-pantry">[\s\S]*400 g pasta/);
    expect(after.body).not.toMatch(/<section id="buy">[\s\S]*pasta[\s\S]*<section id="check-pantry">/);
    expect(after.body).toMatch(/<section id="buy">[\s\S]*tomat/);
  });
});

describe("GET /shopping", () => {
  it("says there is no plan for the week and links to the Plan view", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/shopping" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No plan for this week");
    expect(res.body).toContain(`href="/plan?week=${WEEK}"`);
    expect(res.body).not.toContain('action="/shopping/build"');
  });

  it("shows the stored list in Buy and Check pantry sections with a rebuild form", async () => {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "mjölk", quantity: 2, unit: "dl" }, { name: "pasta", quantity: 400, unit: "g" }] });
    createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
    planWith(app, [pasta]);
    const build = await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });

    expect(build.statusCode).toBe(303);
    expect(build.headers.location).toBe(`/shopping?week=${WEEK}`);
    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<section id="buy">[\s\S]*400 g pasta[\s\S]*<\/section>/);
    expect(res.body).toMatch(/<section id="check-pantry">[\s\S]*2 dl mjölk/);
    expect(res.body.match(/mjölk/g)).toHaveLength(1);
    expect(res.body).toMatch(/<form method="post" action="\/shopping\/build">[\s\S]*name="weekStart" value="2026-10-19"/);
    expect(res.body).toContain('aria-current="page"');
  });

  it("is built automatically when a plan is generated", async () => {
    const app = await start();
    createDish(app.ctx.db, { name: "Toast", prepTimeMinutes: 10, ingredients: [{ name: "bröd", quantity: null, unit: null }] });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(res.body).toMatch(/<section id="buy">[\s\S]*bröd/);
  });

  it("merges one Ingredient from two Dishes into one Buy line and keeps the Preparation Note off the list", async () => {
    const recipes: Record<string, FoundRecipe> = {
      Potatismos: { url: "https://example.com/mos", ingredients: [{ name: "mjölk", quantity: 2, unit: "dl", preparationNote: "till mos" }] },
      Pannkakor: { url: "https://example.com/pannkakor", ingredients: [{ name: "mjölk", quantity: 3, unit: "dl" }] },
    };
    const llm = new ScriptedLlmAgent({ findRecipe: (name) => ({ ok: true, value: recipes[name]! }) });
    const app = await start({ llm });
    const mos = createDish(app.ctx.db, { name: "Potatismos" });
    const pannkakor = createDish(app.ctx.db, { name: "Pannkakor" });
    planWith(app, [mos, pannkakor]);

    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(res.body).toMatch(/<section id="buy">[\s\S]*5 dl mjölk/);
    expect(res.body.match(/5 dl mjölk/g)).toHaveLength(1);
    expect(res.body).not.toContain("till mos");
  });

  it("offers to build the list when the plan has none yet", async () => {
    const app = await start();
    planWith(app, [createDish(app.ctx.db, { name: "Toast" })]);

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("No Shopping List yet");
    expect(res.body).toContain('action="/shopping/build"');
  });
});

describe("Shopping List as the almanac notes page", () => {
  async function builtList(options: Partial<AppOptions> = {}) {
    const app = await start(options);
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
    const gratin = createDish(app.ctx.db, { name: "Gratäng", ingredients: [{ name: "pasta", quantity: 100, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
    const planId = planWith(app, [pasta, gratin]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    return { app, planId };
  }

  it("opens on the week landmark with navigation by ISO week number", async () => {
    const { app } = await builtList();

    const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
    const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(sv.body).toContain('<h1 class="week-num" aria-label="Vecka 43"><small>v.</small>43</h1>');
    expect(sv.body).toMatch(/<a href="\/shopping\?week=2026-10-12" rel="prev"[^>]*>v\. 42 <span aria-hidden="true">‹<\/span><\/a>/);
    expect(sv.body).toMatch(/<a href="\/shopping\?week=2026-10-26" rel="next"[^>]*><span aria-hidden="true">›<\/span> v\. 44<\/a>/);
    expect(en.body).toContain('aria-label="Week 43"');
    expect(en.body).toMatch(/<a href="\/shopping\?week=2026-10-26" rel="next"[^>]*><span aria-hidden="true">›<\/span> wk 44<\/a>/);
  });

  it("shows each Buy line as a ruled row with its source Dishes, in sv and en", async () => {
    const { app } = await builtList();

    const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
    const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(sv.body).toMatch(/<section id="buy"><h2[^>]*>Köp<\/h2>\s*<ul class="rows">/);
    expect(sv.body).toMatch(/500 g pasta<\/span>\s*<span class="row-status">till: Pasta, Gratäng</);
    expect(sv.body).toMatch(/<span class="row-label">ost<\/span>\s*<span class="row-status">till: Gratäng</);
    expect(en.body).toMatch(/<span class="row-status">for: Pasta, Gratäng</);
    expect(sv.body.indexOf('id="buy"')).toBeLessThan(sv.body.indexOf('id="check-pantry"'));
    expect(sv.body).toMatch(/<section id="check-pantry"><h2[^>]*>Kolla skafferiet<\/h2>/);
    expect(sv.body).toMatch(/2 dl mjölk/);
  });

  describe("sink status line", () => {
    it("says where and when the Buy list was sent, with Skicka igen", async () => {
      const { app, planId } = await builtList();
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, 'trello', ?, 1, NULL, NULL)").run(planId, new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
      const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

      expect(sv.body).toContain("Skickad till Trello lör 18:02");
      expect(sv.body).toMatch(/action="\/shopping\/push"[\s\S]*Skicka igen/);
      expect(en.body).toContain("Sent to Trello sat 18:02");
      expect(en.body).toMatch(/action="\/shopping\/push"[\s\S]*Send again/);
      expect(sv.body).not.toContain('role="alert"');
    });

    it("shows an inverted failure block with the reason and Skicka igen", async () => {
      const { app, planId } = await builtList();
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, 'trello', ?, 0, 'Trello HTTP 401', NULL)").run(planId, new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
      const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

      expect(sv.body).toMatch(/<div class="notice" role="alert">[\s\S]*Trello[\s\S]*Trello HTTP 401[\s\S]*action="\/shopping\/push"[\s\S]*Skicka igen/);
      expect(en.body).toMatch(/<div class="notice" role="alert">[\s\S]*Trello HTTP 401[\s\S]*Send again/);
    });
  });
});

describe("Plan Run banner on the Shopping List page", () => {
  /** A Weekly Plan of Köttbullar whose Plan Run is held inside the first recipe lookup. */
  async function heldInIngredients() {
    let release!: (value: LlmResult<FoundRecipe>) => void;
    const held = new Promise<LlmResult<FoundRecipe>>((r) => (release = r));
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(kottbullar), rationale: "r" })) }),
      findRecipe: () => held,
    });
    const app = await start({ llm });
    const kottbullar = createDish(app.ctx.db, { name: "Köttbullar", prepTimeMinutes: 20 });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    for (let i = 0; i < 200; i++) {
      const banner = await app.inject({ method: "GET", url: `/plan-run/banner?week=${WEEK}` });
      if (banner.body.includes("Ingredients")) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    return { app, release };
  }

  it("shows the run's progress with polling and no Rebuild while a run is in flight", async () => {
    const { app, release } = await heldInIngredients();

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("Ingredients 0 of 7: Köttbullar");
    expect(res.body).toContain(`hx-get="/plan-run/banner?week=${WEEK}&amp;shown=ingredient-resolution"`);
    expect(res.body).toContain('hx-trigger="every 2s"');
    expect(res.body).not.toContain('action="/shopping/build"');
    const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
    expect(sv.body).toContain("Ingredienser 0 av 7: Köttbullar");
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("shows the finished outcome without polling and offers Rebuild again", async () => {
    const { app, release } = await heldInIngredients();
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("Plan Run finished 18:30");
    expect(res.body).not.toMatch(/hx-(get|trigger|swap)/);
    expect(res.body).toContain('action="/shopping/build"');
  });

  it("shows a failed run with its reason", async () => {
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });
    const app = await start({ llm });
    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("Plan Run failed 18:30: agent exploded");
  });
});
