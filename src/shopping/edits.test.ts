import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish, getDish } from "../dishes/repo.js";
import { NoAgent } from "../llm/index.js";
import { createPantryItem } from "../pantry/repo.js";
import { writeSetting } from "../db.js";
import type { FetchLike } from "../sinks/types.js";
import { lineIdOf, planWeek, sectionLines, updateList } from "./test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const NEXT_WEEK = "2026-10-26";
const HOOK = "https://hook.example/list";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-shopping-edits-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, llm: new NoAgent(), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = Awaited<ReturnType<typeof buildApp>>;

/** Pasta (pasta, mjölk) and Gratäng (pasta, ost) planned for the week; mjölk is a Pantry Item. Updated. */
async function builtList(options: Partial<AppOptions> = {}) {
  const app = await start(options);
  const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
  const gratin = createDish(app.ctx.db, { name: "Gratäng", ingredients: [{ name: "pasta", quantity: 100, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
  createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
  const planId = planWeek(app.ctx.db, WEEK, [pasta, gratin], NOW.toISOString());
  await updateList(app, planId);
  return { app, pasta, gratin, planId };
}

async function shoppingPage(app: App) {
  const res = await app.inject({ method: "GET", url: "/shopping" });
  expect(res.statusCode).toBe(200);
  return res.body;
}

async function post(app: App, url: string, payload: Record<string, string>, expectLocation = "/shopping") {
  const res = await app.inject({ method: "POST", url, payload });
  expect(res.statusCode, url).toBe(303);
  expect(res.headers.location).toBe(expectLocation);
  return res;
}

/** Records every webhook body sent. */
function hookRecorder() {
  const bodies: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(init?.body ?? "");
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { bodies, fetch };
}

describe("Checked Off lines", () => {
  it("shows a tick control on every Buy and Check pantry line, keyed by line id", async () => {
    const { app } = await builtList();

    const html = await shoppingPage(app);

    for (const name of ["pasta", "ost", "mjölk"]) {
      const id = lineIdOf(html, name);
      expect(html).toMatch(new RegExp(`<form method="post" action="/shopping/check" hx-post="/shopping/check"[^>]*>\\s*<input type="hidden" name="id" value="${id}"`));
    }
    expect(sectionLines(html, "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
    expect(sectionLines(html, "check-pantry")).toEqual([["2 dl mjölk", false]]);
  });

  it("POST check strikes the line through and sorts it after the unchecked lines; uncheck reverses it", async () => {
    const { app } = await builtList();
    const id = lineIdOf(await shoppingPage(app), "pasta");

    await post(app, "/shopping/check", { id });
    const checked = await shoppingPage(app);
    await post(app, "/shopping/uncheck", { id });
    const unchecked = await shoppingPage(app);

    expect(sectionLines(checked, "buy")).toEqual([["ost", false], ["500 g pasta", true]]);
    expect(checked).toMatch(/<li class="row line line-checked"[^>]*>[\s\S]*?action="\/shopping\/uncheck"[\s\S]*?<s class="row-label">500 g pasta<\/s>/);
    expect(sectionLines(unchecked, "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
  });

  it("over HTMX answers with the sections, the same markup as the page", async () => {
    const { app } = await builtList();
    const id = lineIdOf(await shoppingPage(app), "ost");

    const res = await app.inject({ method: "POST", url: "/shopping/check", headers: { "hx-request": "true" }, payload: { id } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/^<div id="shopping-lists">/);
    expect(res.body).not.toContain("<html");
    const page = await shoppingPage(app);
    expect(page).toContain(res.body.trim());
  });

  it("Check pantry lines are tickable too, and a tick does not mark the sent list as changed", async () => {
    const hook = hookRecorder();
    const { app } = await builtList({ fetch: hook.fetch });
    writeSetting(app.ctx.db, "shopping_list_sinks", JSON.stringify([{ type: "webhook", url: HOOK }]));
    await post(app, "/shopping/push", {});
    const html = await shoppingPage(app);

    await post(app, "/shopping/check", { id: lineIdOf(html, "mjölk") });
    await post(app, "/shopping/check", { id: lineIdOf(html, "pasta") });

    const after = await shoppingPage(app);
    expect(sectionLines(after, "check-pantry")).toEqual([["2 dl mjölk", true]]);
    expect(after).toContain("Sent to Webhook");
    expect(after).not.toContain("The list has changed since it was sent.");
  });

  it("keeps the tick when the next week's plan wants the same Ingredient in a smaller amount, and un-ticks when it wants more", async () => {
    const { app, pasta, gratin } = await builtList();
    const html = await shoppingPage(app);
    await post(app, "/shopping/check", { id: lineIdOf(html, "pasta") });
    await post(app, "/shopping/check", { id: lineIdOf(html, "ost") });

    await updateList(app, planWeek(app.ctx.db, NEXT_WEEK, [gratin], NOW.toISOString()));

    const after = await shoppingPage(app);
    expect(sectionLines(after, "buy")).toEqual([["600 g pasta", false], ["ost", true]]);
    expect(getDish(app.ctx.db, pasta)?.name).toBe("Pasta");
  });
});

describe("hand-added lines", () => {
  it("shows the add row after the sections with a name, a datalist of Ingredients and Pantry Items, and an optional quantity", async () => {
    const { app } = await builtList();

    const html = await shoppingPage(app);

    expect(html).toMatch(/<\/div>\s*<form method="post" action="\/shopping\/add" class="line-add">[\s\S]*name="name" required list="shopping-names"[\s\S]*name="quantity"[\s\S]*<\/form>/);
    const options = [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
    expect(options).toEqual(["mjölk", "pasta", "ost"]);
  });

  it("POST add then GET shows the line in Buy with its quantity text, or just the name", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/add", { name: "batteries", quantity: "2 pack" });
    await post(app, "/shopping/add", { name: "candles" });

    const html = await shoppingPage(app);
    expect(sectionLines(html, "buy")).toEqual([["500 g pasta", false], ["ost", false], ["2 pack batteries", false], ["candles", false]]);
    expect(html).not.toMatch(/batteries<\/span>\s*<span class="row-status">for:/);
  });

  it("ignores an add without a name", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/add", { name: "  ", quantity: "2" });

    expect(sectionLines(await shoppingPage(app), "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
  });

  it("un-ticks a line whose name is added again instead of duplicating it, keeping its Dish quantity", async () => {
    const { app } = await builtList();
    await post(app, "/shopping/check", { id: lineIdOf(await shoppingPage(app), "ost") });

    await post(app, "/shopping/add", { name: "Ost", quantity: "1 bit" });

    const html = await shoppingPage(app);
    expect(sectionLines(html, "buy")).toEqual([["500 g pasta", false], ["1 bit ost", false]]);
    expect(html.match(/row-label">[^<]*ost</g)).toHaveLength(1);
  });

  it("lands in Check pantry when a Pantry Item's name or alias matches", async () => {
    const { app } = await builtList();
    createPantryItem(app.ctx.db, { name: "flour", aliases: ["vetemjöl"] });

    await post(app, "/shopping/add", { name: "Vetemjöl" });

    expect(sectionLines(await shoppingPage(app), "check-pantry")).toEqual([["2 dl mjölk", false], ["Vetemjöl", false]]);
  });

  it("a push sends hand-added lines like any other open Buy line, never a ticked one", async () => {
    const hook = hookRecorder();
    const { app } = await builtList({ fetch: hook.fetch });
    writeSetting(app.ctx.db, "shopping_list_sinks", JSON.stringify([{ type: "webhook", url: HOOK }]));
    await post(app, "/shopping/add", { name: "batteries", quantity: "2 pack" });
    await post(app, "/shopping/check", { id: lineIdOf(await shoppingPage(app), "ost") });

    await post(app, "/shopping/push", {});

    expect(hook.bodies).toEqual(["500 g pasta\n2 pack batteries"]);
  });
});

describe("Delete", () => {
  it("shows a Delete control on every line and takes the line off for good", async () => {
    const { app, planId } = await builtList();
    const html = await shoppingPage(app);
    expect([...html.matchAll(/action="\/shopping\/delete"[\s\S]*?name="id" value="(\d+)"/g)].map((m) => m[1])).toEqual([lineIdOf(html, "pasta"), lineIdOf(html, "ost"), lineIdOf(html, "mjölk")]);

    await post(app, "/shopping/delete", { id: lineIdOf(html, "ost") });
    await updateList(app, planId);

    const after = await shoppingPage(app);
    expect(sectionLines(after, "buy")).toEqual([["500 g pasta", false]]);
    // Only the re-add tray still offers it.
    expect(after.slice(0, after.indexOf('class="recent-tray"'))).not.toContain(">ost<");
    expect(after).not.toMatch(/removed|restore/i);
  });

  it("works on a ticked line and on a hand-added line", async () => {
    const { app } = await builtList();
    await post(app, "/shopping/add", { name: "batteries" });
    let html = await shoppingPage(app);
    await post(app, "/shopping/check", { id: lineIdOf(html, "pasta") });

    await post(app, "/shopping/delete", { id: lineIdOf(html, "pasta") });
    await post(app, "/shopping/delete", { id: lineIdOf(html, "batteries") });

    html = await shoppingPage(app);
    expect(sectionLines(html, "buy")).toEqual([["ost", false]]);
  });
});

describe("Clear", () => {
  it("offers Clear with the count only when something is ticked, asks once, and removes every Checked Off line in both sections", async () => {
    const { app } = await builtList();
    expect(await shoppingPage(app)).not.toContain("/shopping/clear");
    let html = await shoppingPage(app);
    await post(app, "/shopping/check", { id: lineIdOf(html, "pasta") });
    await post(app, "/shopping/check", { id: lineIdOf(html, "mjölk") });

    html = await shoppingPage(app);
    expect(html).toContain('<a class="button quiet" href="/shopping/clear">Clear checked (2)</a>');
    const confirm = await app.inject({ method: "GET", url: "/shopping/clear" });
    expect(confirm.body).toContain("2 checked lines will be removed from the Shopping List.");
    expect(confirm.body).toMatch(/<form method="post" action="\/shopping\/clear">[\s\S]*Remove 2 lines/);
    expect(confirm.body).toContain('<a href="/shopping">Keep them</a>');

    await post(app, "/shopping/clear", {}, "/shopping?cleared=2");

    const after = (await app.inject({ method: "GET", url: "/shopping?cleared=2" })).body;
    expect(after).toContain("2 checked lines cleared.");
    expect(sectionLines(after, "buy")).toEqual([["ost", false]]);
    expect(sectionLines(after, "check-pantry")).toEqual([]);
    expect(after).not.toContain("/shopping/clear");
    const sv = (await app.inject({ method: "GET", url: "/shopping/clear", headers: { cookie: "lang=sv" } })).body;
    expect(sv).toContain("Rensa avbockade");
  });

  it("never happens by itself: a Plan Run leaves ticked lines in place", async () => {
    const { app, pasta } = await builtList();
    await post(app, "/shopping/check", { id: lineIdOf(await shoppingPage(app), "ost") });

    await updateList(app, planWeek(app.ctx.db, NEXT_WEEK, [pasta], NOW.toISOString()));

    expect(sectionLines(await shoppingPage(app), "buy")).toEqual([["900 g pasta", false], ["ost", true]]);
  });
});
