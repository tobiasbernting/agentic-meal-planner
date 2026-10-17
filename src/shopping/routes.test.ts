import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent, type FoundRecipe, type LlmResult, type SelectedDish } from "../llm/index.js";
import { createPantryItem, listPantryItems } from "../pantry/repo.js";
import { savePlan } from "../planner/repo.js";
import { writeSetting } from "../db.js";
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

describe("Har alltid hemma over HTMX", () => {
  const hx = { "hx-request": "true" };

  async function withPasta() {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "tomat", quantity: 2, unit: null }] });
    planWith(app, [pasta]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    return app;
  }

  it("returns the Buy and Check pantry sections with the line moved and an Undo control", async () => {
    const app = await withPasta();

    const res = await app.inject({ method: "POST", url: "/shopping/pantry", headers: hx, payload: { weekStart: WEEK, name: "pasta" } });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toMatch(/<section id="check-pantry">[\s\S]*400 g pasta[\s\S]*action="\/shopping\/pantry\/undo"/);
    expect(res.body).toMatch(/<section id="buy">[\s\S]*tomat/);
    expect(res.body).not.toMatch(/<section id="buy">[\s\S]*pasta[\s\S]*<section id="check-pantry">/);
    expect(res.body).toContain("Undo");
  });

  it("Undo deletes the Pantry Item just created and the line returns to Buy", async () => {
    const app = await withPasta();
    const made = await app.inject({ method: "POST", url: "/shopping/pantry", headers: hx, payload: { weekStart: WEEK, name: "pasta" } });
    const id = /name="id" value="(\d+)"/.exec(made.body)![1];

    const res = await app.inject({ method: "POST", url: "/shopping/pantry/undo", headers: hx, payload: { weekStart: WEEK, id } });

    expect(res.statusCode).toBe(200);
    expect(listPantryItems(app.ctx.db)).toEqual([]);
    expect(res.body).toMatch(/<section id="buy">[\s\S]*400 g pasta[\s\S]*<section id="check-pantry">/);
    expect(res.body).not.toContain("Undo");
  });

  it("Undo without the header redirects", async () => {
    const app = await withPasta();
    const item = createPantryItem(app.ctx.db, { name: "pasta", aliases: [] });
    const res = await app.inject({ method: "POST", url: "/shopping/pantry/undo", payload: { weekStart: WEEK, id: String(item.id) } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/shopping?week=${WEEK}`);
    expect(listPantryItems(app.ctx.db)).toEqual([]);
  });

  it("the Buy button posts through HTMX into the sections wrapper", async () => {
    const app = await withPasta();
    const page = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(page.body).toMatch(/<div id="shopping-lists">[\s\S]*hx-post="\/shopping\/pantry"[\s\S]*hx-target="#shopping-lists"/);
  });
});

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

describe("Ingredient language on rebuild", () => {
  /** An agent that finds every recipe and records the language it was asked in. */
  function findingAgent() {
    return new ScriptedLlmAgent({
      findRecipe: (_name, { language }) => ({ ok: true, value: { url: "https://recipes.example/x", ingredients: [{ name: language === "en" ? "beef" : "nötfärs" }] } }),
    });
  }
  const languages = (llm: ScriptedLlmAgent) => llm.calls.filter((c) => c.method === "findRecipe").map((c) => (c.args[1] as { language?: string }).language);

  it("POST /shopping/build asks for the Ingredients in the UI language", async () => {
    const llm = findingAgent();
    const app = await start({ llm });
    planWith(app, [createDish(app.ctx.db, { name: "Burgers" })]);

    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });

    expect(languages(llm)).toEqual(["en"]);
    expect((await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` })).body).toContain("beef");
  });

  it("Har alltid hemma rebuilds in the UI language", async () => {
    const llm = findingAgent();
    const app = await start({ llm });
    planWith(app, [createDish(app.ctx.db, { name: "Burgers" })]);

    await app.inject({ method: "POST", url: "/shopping/pantry", payload: { weekStart: WEEK, name: "salt" } });

    expect(languages(llm)).toEqual(["en"]);
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
    expect(sv.body).toMatch(/<a href="\/shopping\?week=2026-10-12" rel="prev"[^>]*><span aria-hidden="true">‹<\/span> v\. 42<\/a>/);
    expect(sv.body).toMatch(/<a href="\/shopping\?week=2026-10-26" rel="next"[^>]*>v\. 44 <span aria-hidden="true">›<\/span><\/a>/);
    expect(en.body).toContain('aria-label="Week 43"');
    expect(en.body).toMatch(/<a href="\/shopping\?week=2026-10-26" rel="next"[^>]*>wk 44 <span aria-hidden="true">›<\/span><\/a>/);
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
    it("says no recipient is set up, links to Settings, and offers no Skicka igen", async () => {
      const { app } = await builtList();

      const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
      const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

      const sinks = (body: string) => /<section id="sinks">[\s\S]*?<\/section>/.exec(body)![0];
      expect(sinks(sv.body)).toContain('<a href="/settings#recipients">Ingen mottagare inställd</a>');
      expect(sinks(sv.body)).not.toContain("Skicka igen");
      expect(sinks(sv.body)).not.toContain("/shopping/push");
      expect(sinks(en.body)).toContain('<a href="/settings#recipients">No recipient set up</a>');
      expect(sinks(en.body)).not.toContain("Send again");
    });

    it("says no recipient is set up and offers no Skicka igen even after earlier pushes", async () => {
      const { app, planId } = await builtList();
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, 'trello', ?, 0, 'Trello HTTP 401', NULL)").run(planId, new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });

      const sinks = /<section id="sinks">[\s\S]*?<\/section>/.exec(sv.body)![0];
      expect(sinks).toContain('<a href="/settings#recipients">Ingen mottagare inställd</a>');
      expect(sinks).not.toContain("Skicka igen");
      expect(sinks).not.toContain("/shopping/push");
    });

    it("says where and when the Buy list was sent, with Skicka igen", async () => {
      const { app, planId } = await builtList();
      writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, 'trello', ?, 1, NULL, NULL)").run(planId, new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
      const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

      expect(sv.body).toContain("Skickad till Trello lör 18:02");
      expect(sv.body).toMatch(/action="\/shopping\/push"[\s\S]*Skicka igen/);
      expect(en.body).toContain("Sent to Trello sat 18:02");
      expect(en.body).toMatch(/action="\/shopping\/push"[\s\S]*Send again/);
      expect(sv.body).not.toContain('role="alert"');
    });

    it("says the list has changed since it was sent once a rebuild changes the Buy list, until it is sent again", async () => {
      const okFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      const app = await start({ fetch: okFetch });
      writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
      const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
      planWith(app, [pasta]);
      await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
      const sinks = async (cookie = "lang=en") =>
        /<section id="sinks">[\s\S]*?<\/section>/.exec((await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie } })).body)![0];

      const sent = await sinks();
      await app.inject({ method: "POST", url: "/shopping/pantry", payload: { weekStart: WEEK, name: "ost" } });
      const changed = await sinks();
      const changedSv = await sinks("lang=sv");
      await app.inject({ method: "POST", url: "/shopping/push", payload: { weekStart: WEEK } });
      const resent = await sinks();

      expect(sent).toContain("Sent to Webhook");
      expect(sent).not.toContain("changed since it was sent");
      expect(changed).toMatch(/Sent to Webhook[\s\S]*The list has changed since it was sent\.[\s\S]*Send again/);
      expect(changedSv).toContain("Listan har ändrats sedan den skickades.");
      expect(resent).not.toContain("changed since it was sent");
    });

    it("shows an inverted failure block with the reason and Skicka igen", async () => {
      const { app, planId } = await builtList();
      writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, 'trello', ?, 0, 'Trello HTTP 401', NULL)").run(planId, new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
      const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

      expect(sv.body).toMatch(/<div class="notice" role="alert">[\s\S]*Trello[\s\S]*Trello HTTP 401[\s\S]*action="\/shopping\/push"[\s\S]*Skicka igen/);
      expect(en.body).toMatch(/<div class="notice" role="alert">[\s\S]*Trello HTTP 401[\s\S]*Send again/);
    });
  });
});

describe("Shopping List changes while a Plan Run is in flight", () => {
  /** A built Shopping List (Buy: pasta) whose week has a new Plan Run held in Dish selection. */
  async function builtListWithRunInFlight() {
    let release!: (value: LlmResult<SelectedDish[]>) => void;
    const held = new Promise<LlmResult<SelectedDish[]>>((r) => (release = r));
    const app = await start({ llm: new ScriptedLlmAgent({ selectDishes: () => held }) });
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
    planWith(app, [pasta]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    const finish = async () => {
      release({ ok: false, reason: "released" });
      await planRunSettled(app, WEEK);
    };
    return { app, finish };
  }

  it("hides Har alltid hemma", async () => {
    const { app, finish } = await builtListWithRunInFlight();

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toMatch(/<section id="buy">[\s\S]*400 g pasta/);
    expect(res.body).not.toContain('action="/shopping/pantry"');
    await finish();
  });

  it.each([
    ["/shopping/build", { weekStart: WEEK }],
    ["/shopping/pantry", { weekStart: WEEK, name: "pasta" }],
  ])("refuses POST %s with a run-in-progress notice and changes nothing", async (url, payload) => {
    const { app, finish } = await builtListWithRunInFlight();

    const res = await app.inject({ method: "POST", url, payload });
    const view = await app.inject({ method: "GET", url: res.headers.location as string });
    const sv = await app.inject({ method: "GET", url: res.headers.location as string, headers: { cookie: "lang=sv" } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/shopping?week=${WEEK}&notice=run-in-progress`);
    expect(listPantryItems(app.ctx.db)).toEqual([]);
    expect(view.body).toContain("A Plan Run is in progress for this week. The Shopping List was not changed.");
    expect(sv.body).toContain("En planering pågår för den här veckan. Inköpslistan ändrades inte.");
    await finish();
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
    expect(res.body).toContain('class="plan-run plan-run-active notice" role="status"');
    expect(res.body.indexOf('id="plan-run-banner"')).toBeGreaterThan(res.body.indexOf('class="week-nav"'));
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

describe("Dishes without Ingredients on the Shopping List", () => {
  /** An agent that finds Burgers' recipe, and Soppa's only once `soppaWorks` is set. */
  function flakyAgent(selectDishes?: () => Promise<LlmResult<SelectedDish[]>>) {
    const state = { soppaWorks: false };
    const llm = new ScriptedLlmAgent({
      ...(selectDishes ? { selectDishes } : {}),
      findRecipe: (name) =>
        name === "Soppa" && !state.soppaWorks
          ? { ok: false, reason: "agent refused" }
          : { ok: true, value: { url: `https://recipes.example/${name}`, ingredients: [{ name: name === "Soppa" ? "ärtor" : "nötfärs", quantity: 500, unit: "g" }] } },
    });
    return { llm, state };
  }

  async function planned(llm: ScriptedLlmAgent) {
    const app = await start({ llm });
    planWith(app, [createDish(app.ctx.db, { name: "Burgers" }), createDish(app.ctx.db, { name: "Soppa" })]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    return app;
  }

  it("names the Dish in a status block, in sv and en", async () => {
    const { llm } = flakyAgent();
    const app = await planned(llm);

    const en = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });

    expect(en.body).toMatch(/<div class="notice" role="status">[\s\S]*Ingredients missing for Soppa[\s\S]*action="\/shopping\/retry"[\s\S]*Try again/);
    expect(en.body).not.toMatch(/Ingredients missing for[^<]*Burgers/);
    expect(sv.body).toMatch(/role="status">[\s\S]*Ingredienser saknas för Soppa[\s\S]*Försök igen/);
  });

  it("Försök igen re-resolves only that Dish and removes the block once it works", async () => {
    const { llm, state } = flakyAgent();
    const app = await planned(llm);
    state.soppaWorks = true;
    const callsBefore = llm.calls.filter((c) => c.method === "findRecipe").length;

    const res = await app.inject({ method: "POST", url: "/shopping/retry", payload: { weekStart: WEEK } });
    const view = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/shopping?week=${WEEK}`);
    expect(llm.calls.filter((c) => c.method === "findRecipe").slice(callsBefore).map((c) => c.args[0])).toEqual(["Soppa"]);
    expect(view.body).not.toContain("Ingredients missing for");
    expect(view.body).toMatch(/<section id="buy">[\s\S]*500 g ärtor/);
    expect(view.body).toMatch(/500 g nötfärs/);
  });

  it("Försök igen asks again for a Dish whose recipe came back with no Ingredients", async () => {
    let soppaIngredients: FoundRecipe["ingredients"] = [];
    const llm = new ScriptedLlmAgent({
      findRecipe: (name) => ({ ok: true, value: { url: `https://recipes.example/${name}`, ingredients: name === "Soppa" ? soppaIngredients : [{ name: "nötfärs", quantity: 500, unit: "g" }] } }),
    });
    const app = await planned(llm);
    soppaIngredients = [{ name: "ärtor", quantity: 500, unit: "g" }];
    const callsBefore = llm.calls.filter((c) => c.method === "findRecipe").length;

    await app.inject({ method: "POST", url: "/shopping/retry", payload: { weekStart: WEEK } });
    const view = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(llm.calls.filter((c) => c.method === "findRecipe").slice(callsBefore).map((c) => c.args[0])).toEqual(["Soppa"]);
    expect(view.body).not.toContain("Ingredients missing for");
    expect(view.body).toMatch(/500 g ärtor/);
  });

  it("Försök igen does not send the list to the sinks", async () => {
    const pushed: string[] = [];
    const fetch = async (url: string) => {
      pushed.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const { llm, state } = flakyAgent();
    const app = await start({ llm, fetch });
    planWith(app, [createDish(app.ctx.db, { name: "Burgers" }), createDish(app.ctx.db, { name: "Soppa" })]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
    state.soppaWorks = true;

    await app.inject({ method: "POST", url: "/shopping/retry", payload: { weekStart: WEEK } });

    expect(pushed).toEqual([]);
  });

  it("hides Försök igen and refuses it while a Plan Run is in flight", async () => {
    let release!: (value: LlmResult<SelectedDish[]>) => void;
    const held = new Promise<LlmResult<SelectedDish[]>>((r) => (release = r));
    const { llm } = flakyAgent(() => held);
    const app = await planned(llm);
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    const view = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    const res = await app.inject({ method: "POST", url: "/shopping/retry", payload: { weekStart: WEEK } });

    expect(view.body).toContain("Ingredients missing for Soppa");
    expect(view.body).not.toContain('action="/shopping/retry"');
    expect(res.headers.location).toBe(`/shopping?week=${WEEK}&notice=run-in-progress`);
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });
});
