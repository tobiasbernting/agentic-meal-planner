import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent, type FoundRecipe, type LlmResult, type SelectedDish } from "../llm/index.js";
import { createPantryItem, listPantryItems } from "../pantry/repo.js";
import { writeSetting } from "../db.js";
import { planRunSettled, postPlanRun } from "../plan-run/test-helpers.js";
import { lineIdOf, planWeek, sectionLines, updateList } from "./test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const NEXT_WEEK = "2026-10-26";
const hx = { "hx-request": "true" };

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-shopping-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, llm: new NoAgent(), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = Awaited<ReturnType<typeof buildApp>>;

async function shoppingPage(app: App, cookie?: string) {
  const res = await app.inject({ method: "GET", url: "/shopping", ...(cookie ? { headers: { cookie } } : {}) });
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** Pasta (pasta, tomat) planned for Monday, updated. */
async function withPasta(options: Partial<AppOptions> = {}) {
  const app = await start(options);
  const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "tomat", quantity: 2, unit: null }] });
  const planId = planWeek(app.ctx.db, WEEK, [pasta], NOW.toISOString());
  await updateList(app, planId);
  return { app, pasta, planId };
}

describe("Har alltid hemma", () => {
  it("over HTMX returns the sections with the line moved in place and an Undo control, and creates the Pantry Item", async () => {
    const { app } = await withPasta();
    const id = lineIdOf(await shoppingPage(app), "pasta");

    const res = await app.inject({ method: "POST", url: "/shopping/pantry", headers: hx, payload: { id, name: "pasta" } });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toMatch(/<section id="check-pantry">[\s\S]*400 g pasta[\s\S]*action="\/shopping\/pantry\/undo"/);
    expect(res.body).toMatch(/<section id="buy">[\s\S]*tomat/);
    expect(res.body).not.toMatch(/<section id="buy">[\s\S]*pasta[\s\S]*<section id="check-pantry">/);
    expect(res.body).toContain("Undo");
    expect(res.body).toContain('hx-get="/shopping/sections"');
    expect(listPantryItems(app.ctx.db).map((p) => p.name)).toEqual(["pasta"]);
  });

  it("Undo deletes the Pantry Item just created and the line returns to Buy", async () => {
    const { app } = await withPasta();
    const id = lineIdOf(await shoppingPage(app), "pasta");
    const made = await app.inject({ method: "POST", url: "/shopping/pantry", headers: hx, payload: { id, name: "pasta" } });
    const pantryId = /name="pantryId" value="(\d+)"/.exec(made.body)![1];

    const res = await app.inject({ method: "POST", url: "/shopping/pantry/undo", headers: hx, payload: { id, pantryId } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<section id="buy">[\s\S]*400 g pasta/);
    expect(res.body).not.toContain("/shopping/pantry/undo");
    expect(listPantryItems(app.ctx.db)).toEqual([]);
  });

  it("does not create a second Pantry Item when one already matches, and offers no Pantry delete on Undo", async () => {
    const { app } = await withPasta();
    createPantryItem(app.ctx.db, { name: "Pasta", aliases: [] });
    const id = lineIdOf(await shoppingPage(app), "pasta");

    const res = await app.inject({ method: "POST", url: "/shopping/pantry", headers: hx, payload: { id, name: "pasta" } });

    expect(listPantryItems(app.ctx.db)).toHaveLength(1);
    expect(res.body).toContain("/shopping/pantry/undo");
    expect(res.body).not.toContain('name="pantryId"');
  });

  it("without the header redirects to the list", async () => {
    const { app } = await withPasta();
    const id = lineIdOf(await shoppingPage(app), "pasta");

    const res = await app.inject({ method: "POST", url: "/shopping/pantry", payload: { id, name: "pasta" } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/shopping");
    expect(sectionLines(await shoppingPage(app), "check-pantry")).toEqual([["400 g pasta", false]]);
  });

  it("the Buy button posts through HTMX into the sections wrapper", async () => {
    const { app } = await withPasta();

    const html = await shoppingPage(app);

    expect(html).toMatch(/<form method="post" action="\/shopping\/pantry" hx-post="\/shopping\/pantry" hx-target="#shopping-lists" hx-swap="outerHTML">/);
    expect(html).toContain('<div id="shopping-lists">');
  });
});

describe("GET /shopping", () => {
  it("says the list is empty and links to the Plan when nothing is on it", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/shopping" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("The Shopping List is empty. Add something, or plan the week.");
    expect(res.body).toContain('href="/plan"');
    expect(res.body).toContain('action="/shopping/add"');
    expect(res.body).not.toContain('class="week-nav"');
  });

  it("shows the list in Buy and Check pantry sections, the same whatever week is asked for", async () => {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "mjölk", quantity: 2, unit: "dl" }, { name: "pasta", quantity: 400, unit: "g" }] });
    createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
    await updateList(app, planWeek(app.ctx.db, WEEK, [pasta], NOW.toISOString()));

    const res = await app.inject({ method: "GET", url: "/shopping" });
    const other = await app.inject({ method: "GET", url: `/shopping?week=${NEXT_WEEK}` });

    expect(res.body).toMatch(/<section id="buy">[\s\S]*400 g pasta[\s\S]*<\/section>/);
    expect(res.body).toMatch(/<section id="check-pantry">[\s\S]*2 dl mjölk/);
    expect(res.body.match(/row-label">[^<]*mjölk/g)).toHaveLength(1);
    expect(res.body).not.toContain("/shopping/build");
    expect(res.body).toContain('aria-current="page"');
    expect(other.body).toMatch(/<section id="buy">[\s\S]*400 g pasta/);
  });

  it("is updated automatically when a plan is generated", async () => {
    const app = await start();
    createDish(app.ctx.db, { name: "Toast", prepTimeMinutes: 10, ingredients: [{ name: "bröd", quantity: null, unit: null }] });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const res = await app.inject({ method: "GET", url: "/shopping" });
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

    await updateList(app, planWeek(app.ctx.db, WEEK, [mos, pannkakor], NOW.toISOString()));

    const res = await app.inject({ method: "GET", url: "/shopping" });
    expect(res.body).toMatch(/<section id="buy">[\s\S]*5 dl mjölk/);
    expect(res.body.match(/5 dl mjölk/g)).toHaveLength(1);
    expect(res.body).not.toContain("till mos");
  });

  it("asks for the Ingredients in the UI language on a Plan Run and on Försök igen", async () => {
    const llm = new ScriptedLlmAgent({ findRecipe: { ok: false, reason: "nope" } });
    const app = await start({ llm });
    createDish(app.ctx.db, { name: "Soppa", prepTimeMinutes: 10 });
    const languages = () => llm.calls.filter((c) => c.method === "findRecipe").map((c) => (c.args[1] as { language?: string }).language);

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });
    const before = languages().length;
    await app.inject({ method: "POST", url: "/shopping/retry", headers: { cookie: "lang=sv" } });

    expect(languages().slice(0, before).every((l) => l === "en")).toBe(true);
    expect(languages().slice(before).every((l) => l === "sv")).toBe(true);
    expect(languages().length).toBeGreaterThan(before);
  });
});

describe("Shopping List as the almanac notes page", () => {
  /** Pasta (pasta, mjölk) on Monday and Gratäng (pasta, ost) on Tuesday; mjölk is a Pantry Item. */
  async function builtList(options: Partial<AppOptions> = {}) {
    const app = await start(options);
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
    const gratin = createDish(app.ctx.db, { name: "Gratäng", ingredients: [{ name: "pasta", quantity: 100, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
    const planId = planWeek(app.ctx.db, WEEK, [pasta, gratin], NOW.toISOString());
    await updateList(app, planId);
    return { app, planId };
  }

  it("opens on this week's landmark, without week navigation", async () => {
    const { app } = await builtList();

    const sv = await shoppingPage(app, "lang=sv");
    const en = await shoppingPage(app);

    expect(sv).toContain('<h1 class="week-num" aria-label="Vecka 43"><small>v.</small>43</h1>');
    expect(sv).not.toContain('class="week-nav"');
    expect(en).toContain('aria-label="Week 43"');
  });

  it("shows each Buy line as a ruled row with the dinners and dates it is for, in sv and en", async () => {
    const { app } = await builtList();

    const sv = await shoppingPage(app, "lang=sv");
    const en = await shoppingPage(app);

    expect(sv).toMatch(/<section id="buy"><h2[^>]*>Köp<\/h2>\s*<ul class="rows">/);
    expect(sv).toMatch(/500 g pasta<\/span>\s*<span class="row-status">till: Pasta \(mån 19 okt\), Gratäng \(tis 20 okt\)</);
    expect(sv).toMatch(/<span class="row-label">ost<\/span>\s*<span class="row-status">till: Gratäng \(tis 20 okt\)</);
    expect(en).toMatch(/<span class="row-status">for: Pasta \(mon 19 Oct\), Gratäng \(tue 20 Oct\)</);
    expect(sv.indexOf('id="buy"')).toBeLessThan(sv.indexOf('id="check-pantry"'));
    expect(sv).toMatch(/<section id="check-pantry"><h2[^>]*>Kolla skafferiet<\/h2>/);
    expect(sv).toMatch(/2 dl mjölk/);
  });

  describe("sink status line", () => {
    const sinks = (body: string) => /<section id="sinks">[\s\S]*?<\/section>/.exec(body)![0];

    it("says no recipient is set up, links to Settings, and offers no Skicka igen", async () => {
      const { app } = await builtList();

      const sv = await shoppingPage(app, "lang=sv");
      const en = await shoppingPage(app);

      expect(sinks(sv)).toContain('<a href="/settings#recipients">Ingen mottagare inställd</a>');
      expect(sinks(sv)).not.toContain("Skicka igen");
      expect(sinks(sv)).not.toContain("/shopping/push");
      expect(sinks(en)).toContain('<a href="/settings#recipients">No recipient set up</a>');
      expect(sinks(en)).not.toContain("Send again");
    });

    it("says no recipient is set up and offers no Skicka igen even after earlier pushes", async () => {
      const { app, planId } = await builtList();
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, 'webhook', ?, 0, 'Webhook HTTP 401', NULL)").run(planId, new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await shoppingPage(app, "lang=sv");

      expect(sinks(sv)).toContain('<a href="/settings#recipients">Ingen mottagare inställd</a>');
      expect(sinks(sv)).not.toContain("Skicka igen");
      expect(sinks(sv)).not.toContain("/shopping/push");
    });

    it("says where and when the Buy list was sent, with Skicka igen", async () => {
      const { app } = await builtList();
      writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (NULL, 'webhook', ?, 1, NULL, NULL)").run(new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await shoppingPage(app, "lang=sv");
      const en = await shoppingPage(app);

      expect(sv).toContain("Skickad till Webhook lör 18:02");
      expect(sv).toMatch(/action="\/shopping\/push"[\s\S]*Skicka igen/);
      expect(en).toContain("Sent to Webhook sat 18:02");
      expect(en).toMatch(/action="\/shopping\/push"[\s\S]*Send again/);
      expect(sv).not.toContain('role="alert"');
    });

    it("says the list has changed since it was sent once an edit changes the open Buy lines, until it is sent again", async () => {
      const okFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      const app = await start({ fetch: okFetch });
      writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
      const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
      await updateList(app, planWeek(app.ctx.db, WEEK, [pasta], NOW.toISOString()));
      await app.inject({ method: "POST", url: "/shopping/push" });
      const sinksNow = async (cookie = "lang=en") => sinks(await shoppingPage(app, cookie));

      const sent = await sinksNow();
      await app.inject({ method: "POST", url: "/shopping/pantry", payload: { id: lineIdOf(await shoppingPage(app), "ost"), name: "ost" } });
      const changed = await sinksNow();
      const changedSv = await sinksNow("lang=sv");
      await app.inject({ method: "POST", url: "/shopping/push" });
      const resent = await sinksNow();

      expect(sent).toContain("Sent to Webhook");
      expect(sent).not.toContain("changed since it was sent");
      expect(changed).toMatch(/Sent to Webhook[\s\S]*The list has changed since it was sent\.[\s\S]*Send again/);
      expect(changedSv).toContain("Listan har ändrats sedan den skickades.");
      expect(resent).not.toContain("changed since it was sent");
    });

    it("shows an inverted failure block with the reason and Skicka igen", async () => {
      const { app } = await builtList();
      writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
      app.ctx.db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (NULL, 'webhook', ?, 0, 'Webhook HTTP 401', NULL)").run(new Date(2026, 9, 24, 18, 2).toISOString());

      const sv = await shoppingPage(app, "lang=sv");
      const en = await shoppingPage(app);

      expect(sv).toMatch(/<div class="notice" role="alert">[\s\S]*Webhook[\s\S]*Webhook HTTP 401[\s\S]*action="\/shopping\/push"[\s\S]*Skicka igen/);
      expect(en).toMatch(/<div class="notice" role="alert">[\s\S]*Webhook HTTP 401[\s\S]*Send again/);
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

  it("shows this week's run with its progress and polling while it is in flight", async () => {
    const { app, release } = await heldInIngredients();

    const res = await app.inject({ method: "GET", url: "/shopping" });

    expect(res.body).toContain("Ingredients 0 of 7: Köttbullar");
    expect(res.body).toContain(`hx-get="/plan-run/banner?week=${WEEK}&amp;shown=ingredient-resolution"`);
    expect(res.body).toContain('hx-trigger="every 2s"');
    expect(res.body).toContain('class="plan-run plan-run-active notice" role="status"');
    const sv = await app.inject({ method: "GET", url: "/shopping", headers: { cookie: "lang=sv" } });
    expect(sv.body).toContain("Ingredienser 0 av 7: Köttbullar");
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("shows the finished outcome without polling, and the update Phase by its name", async () => {
    const { app, release } = await heldInIngredients();
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);

    const res = await app.inject({ method: "GET", url: "/shopping" });

    expect(res.body).toContain("Plan Run finished 18:30");
    expect(res.body).not.toMatch(/hx-(get|trigger|swap)/);
  });

  it("shows a failed run with its reason, and next week's run too", async () => {
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });
    const app = await start({ llm });
    await postPlanRun(app, "/plan/generate", { weekStart: NEXT_WEEK });

    const res = await app.inject({ method: "GET", url: "/shopping" });

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
    await updateList(app, planWeek(app.ctx.db, WEEK, [createDish(app.ctx.db, { name: "Burgers" }), createDish(app.ctx.db, { name: "Soppa" })], NOW.toISOString()));
    return app;
  }

  it("names the Dish and its date in a status block, in sv and en", async () => {
    const { llm } = flakyAgent();
    const app = await planned(llm);

    const en = await shoppingPage(app);
    const sv = await shoppingPage(app, "lang=sv");

    expect(en).toMatch(/<div class="notice" role="status">[\s\S]*Ingredients missing for Soppa \(tue 20 Oct\)[\s\S]*action="\/shopping\/retry"[\s\S]*Try again/);
    expect(en).not.toMatch(/Ingredients missing for[^<]*Burgers/);
    expect(sv).toMatch(/role="status">[\s\S]*Ingredienser saknas för Soppa \(tis 20 okt\)[\s\S]*Försök igen/);
  });

  it("Försök igen re-resolves only that Dish and removes the block once it works", async () => {
    const { llm, state } = flakyAgent();
    const app = await planned(llm);
    state.soppaWorks = true;
    const callsBefore = llm.calls.filter((c) => c.method === "findRecipe").length;

    const res = await app.inject({ method: "POST", url: "/shopping/retry" });
    const view = await shoppingPage(app);

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/shopping");
    expect(llm.calls.filter((c) => c.method === "findRecipe").slice(callsBefore).map((c) => c.args[0])).toEqual(["Soppa"]);
    expect(view).not.toContain("Ingredients missing for");
    expect(view).toMatch(/<section id="buy">[\s\S]*500 g ärtor/);
    expect(view).toMatch(/500 g nötfärs/);
  });

  it("Försök igen asks again for a Dish whose recipe came back with no Ingredients", async () => {
    let soppaIngredients: FoundRecipe["ingredients"] = [];
    const llm = new ScriptedLlmAgent({
      findRecipe: (name) => ({ ok: true, value: { url: `https://recipes.example/${name}`, ingredients: name === "Soppa" ? soppaIngredients : [{ name: "nötfärs", quantity: 500, unit: "g" }] } }),
    });
    const app = await planned(llm);
    soppaIngredients = [{ name: "ärtor", quantity: 500, unit: "g" }];
    const callsBefore = llm.calls.filter((c) => c.method === "findRecipe").length;

    await app.inject({ method: "POST", url: "/shopping/retry" });
    const view = await shoppingPage(app);

    expect(llm.calls.filter((c) => c.method === "findRecipe").slice(callsBefore).map((c) => c.args[0])).toEqual(["Soppa"]);
    expect(view).not.toContain("Ingredients missing for");
    expect(view).toMatch(/500 g ärtor/);
  });

  it("Försök igen does not send the list to the sinks", async () => {
    const pushed: string[] = [];
    const fetch = async (url: string) => {
      pushed.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const { llm, state } = flakyAgent();
    const app = await start({ llm, fetch });
    await updateList(app, planWeek(app.ctx.db, WEEK, [createDish(app.ctx.db, { name: "Burgers" }), createDish(app.ctx.db, { name: "Soppa" })], NOW.toISOString()));
    writeSetting(app.ctx.db, "shopping_list_sinks", '[{"type":"webhook","url":"https://hook.example/list"}]');
    state.soppaWorks = true;

    await app.inject({ method: "POST", url: "/shopping/retry" });

    expect(pushed).toEqual([]);
  });

  it("hides Försök igen and refuses it while the dinner's week has a Plan Run in flight", async () => {
    let release!: (value: LlmResult<SelectedDish[]>) => void;
    const held = new Promise<LlmResult<SelectedDish[]>>((r) => (release = r));
    const { llm } = flakyAgent(() => held);
    const app = await planned(llm);
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    const view = await shoppingPage(app);
    const res = await app.inject({ method: "POST", url: "/shopping/retry" });
    const refused = await app.inject({ method: "GET", url: res.headers.location as string });

    expect(view).toContain("Ingredients missing for Soppa");
    expect(view).not.toContain('action="/shopping/retry"');
    expect(res.headers.location).toBe("/shopping?notice=run-in-progress");
    expect(refused.body).toContain("A Plan Run is in progress. Try again when it has finished.");
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });
});
