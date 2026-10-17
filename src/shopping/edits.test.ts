import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish, getDish } from "../dishes/repo.js";
import { NoAgent } from "../llm/index.js";
import { createPantryItem } from "../pantry/repo.js";
import { savePlan } from "../planner/repo.js";
import type { FetchLike } from "../sinks/types.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const NEXT_WEEK = "2026-10-26";
const ENV = { TRELLO_KEY: "k", TRELLO_TOKEN: "t0ken", TRELLO_BOARD_ID: "b1" };

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

function planWith(app: App, weekStart: string, dishIds: number[]) {
  const monday = new Date(`${weekStart}T00:00:00Z`);
  return savePlan(
    app.ctx.db,
    {
      weekStart,
      dinners: dishIds.map((dishId, i) => {
        const d = new Date(monday);
        d.setUTCDate(d.getUTCDate() + i);
        return { date: d.toISOString().slice(0, 10), dishId, isQuickDay: false, lunchThatDay: null, rationale: "r" };
      }),
      degradedReasons: [],
    },
    NOW.toISOString(),
  );
}

/** Pasta (pasta, mjölk) and Gratäng (pasta, ost) planned for the week; mjölk is a Pantry Item. Built. */
async function builtList(options: Partial<AppOptions> = {}, weekStart = WEEK) {
  const app = await start(options);
  const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
  const gratin = createDish(app.ctx.db, { name: "Gratäng", ingredients: [{ name: "pasta", quantity: 100, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
  createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
  planWith(app, weekStart, [pasta, gratin]);
  await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart } });
  return { app, pasta, gratin };
}

async function shoppingPage(app: App, weekStart = WEEK) {
  const res = await app.inject({ method: "GET", url: `/shopping?week=${weekStart}` });
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** The lines of a section as [label, checked], in document order. */
function lines(html: string, section: "buy" | "check-pantry"): [string, boolean][] {
  const block = new RegExp(`<section id="${section}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? "";
  return [...block.matchAll(/<li class="row line([^"]*)"[\s\S]*?<(?:span|s) class="row-label">([^<]*)<\/(?:span|s)>/g)].map((m) => [m[2]!, m[1]!.includes("line-checked")]);
}

async function post(app: App, url: string, payload: Record<string, string>) {
  const res = await app.inject({ method: "POST", url, payload });
  expect(res.statusCode, url).toBe(303);
  expect(res.headers.location).toBe(`/shopping?week=${payload.weekStart}`);
  return res;
}

/** Records every sink call and fakes an empty Trello board. */
function trelloRecorder() {
  const calls: { url: string; method?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init?.method ? { method: init.method } : {}) });
    if (init?.method === "POST" && /\/boards\/b1\/lists\?/.test(url)) return { ok: true, status: 200, json: async () => ({ id: "list1", name: "x" }) };
    if (init?.method === undefined || init.method === "GET") return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ id: "x" }) };
  };
  const cardNames = () => calls.filter((c) => c.url.includes("/cards?")).map((c) => new URL(c.url).searchParams.get("name"));
  return { calls, fetch, cardNames };
}

describe("Extra Items", () => {
  it("shows an add row at the end of Buy with name and optional quantity fields", async () => {
    const { app } = await builtList();

    const html = await shoppingPage(app);

    const buy = /<section id="buy">([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(buy).toMatch(/<\/ul>\s*<form method="post" action="\/shopping\/extra" class="extra-add">[\s\S]*name="name" required[\s\S]*name="quantity"[\s\S]*<\/form>\s*$/);
  });

  it("POST add then GET shows the Extra Item in Buy with its quantity text, or just the name", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/extra", { weekStart: WEEK, name: "batteries", quantity: "2 pack" });
    await post(app, "/shopping/extra", { weekStart: WEEK, name: "candles" });

    const html = await shoppingPage(app);
    expect(lines(html, "buy")).toEqual([["500 g pasta", false], ["ost", false], ["2 pack batteries", false], ["candles", false]]);
    expect(lines(html, "check-pantry")).toEqual([["2 dl mjölk", false]]);
    expect(html).toMatch(/<form method="post" action="\/shopping\/check">[\s\S]*?name="name" value="batteries"/);
  });

  it("ignores an add without a name", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/extra", { weekStart: WEEK, name: "  ", quantity: "2" });

    expect(lines(await shoppingPage(app), "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
  });

  it("keeps the Extra Item through a rebuild and is per week", async () => {
    const { app, pasta } = await builtList();
    planWith(app, NEXT_WEEK, [pasta]);
    await post(app, "/shopping/extra", { weekStart: WEEK, name: "batteries" });

    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: NEXT_WEEK } });

    expect(lines(await shoppingPage(app, WEEK), "buy")).toEqual([["500 g pasta", false], ["ost", false], ["batteries", false]]);
    expect(lines(await shoppingPage(app, NEXT_WEEK), "buy")).toEqual([["400 g pasta", false]]);
  });

  it("POST delete removes the Extra Item outright, with no removed-lines entry", async () => {
    const { app } = await builtList();
    await post(app, "/shopping/extra", { weekStart: WEEK, name: "batteries" });
    const id = /action="\/shopping\/extra\/delete">[\s\S]*?name="id" value="(\d+)"/.exec(await shoppingPage(app))![1]!;

    await post(app, "/shopping/extra/delete", { weekStart: WEEK, id });

    const html = await shoppingPage(app);
    expect(lines(html, "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
    expect(html).not.toContain("batteries");
    expect(html).not.toMatch(/removed/i);
  });

  it("a push after adding sends the Extra Item, and a Checked Off line like any other", async () => {
    const trello = trelloRecorder();
    const { app } = await builtList({ env: ENV, fetch: trello.fetch });
    await post(app, "/shopping/extra", { weekStart: WEEK, name: "batteries", quantity: "2 pack" });
    await post(app, "/shopping/check", { weekStart: WEEK, name: "ost" });
    trello.calls.length = 0;

    await app.inject({ method: "POST", url: "/shopping/push", payload: { weekStart: WEEK } });

    expect(trello.cardNames()).toEqual(["500 g pasta", "2 pack batteries", "ost"]);
  });
});

describe("Removed Lines", () => {
  /** The "N removed" disclosure: its summary text and the restorable lines' names. */
  function removed(html: string): { summary: string; names: string[] } | undefined {
    const m = /<details id="removed">\s*<summary>([^<]*)<\/summary>([\s\S]*?)<\/details>/.exec(html);
    if (!m) return undefined;
    return { summary: m[1]!, names: [...m[2]!.matchAll(/action="\/shopping\/restore">[\s\S]*?name="name" value="([^"]*)"/g)].map((r) => r[1]!) };
  }

  it("shows a remove control on every Dish-derived line in Buy and Check pantry, none on an Extra Item", async () => {
    const { app } = await builtList();
    await post(app, "/shopping/extra", { weekStart: WEEK, name: "batteries" });

    const html = await shoppingPage(app);

    const removes = [...html.matchAll(/action="\/shopping\/remove">[\s\S]*?name="name" value="([^"]*)"/g)].map((m) => m[1]);
    expect(removes).toEqual(["pasta", "ost", "mjölk"]);
    expect(removed(html)).toBeUndefined();
  });

  it("POST remove takes the line off its section and lists it as 1 removed with a restore control", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/remove", { weekStart: WEEK, name: "pasta" });

    const html = await shoppingPage(app);
    expect(lines(html, "buy")).toEqual([["ost", false]]);
    expect(removed(html)).toEqual({ summary: "1 removed", names: ["pasta"] });
    expect(html).toContain("500 g pasta");
    const sv = (await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } })).body;
    expect(removed(sv)?.summary).toBe("1 borttagen");
  });

  it("keeps the line removed through a rebuild and POST restore puts it back", async () => {
    const { app, pasta } = await builtList();
    await post(app, "/shopping/remove", { weekStart: WEEK, name: "Mjölk" });
    await post(app, "/shopping/remove", { weekStart: WEEK, name: "ost" });

    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    const afterRebuild = await shoppingPage(app);
    await post(app, "/shopping/restore", { weekStart: WEEK, name: "ost" });
    const afterRestore = await shoppingPage(app);

    expect(lines(afterRebuild, "buy")).toEqual([["500 g pasta", false]]);
    expect(lines(afterRebuild, "check-pantry")).toEqual([]);
    expect(removed(afterRebuild)).toEqual({ summary: "2 removed", names: ["ost", "mjölk"] });
    expect(lines(afterRestore, "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
    expect(removed(afterRestore)).toEqual({ summary: "1 removed", names: ["mjölk"] });
    expect(getDish(app.ctx.db, pasta)?.ingredients.map((i) => i.name)).toEqual(["pasta", "mjölk"]);
  });

  it("a push after a removal does not send the Removed Line", async () => {
    const trello = trelloRecorder();
    const { app } = await builtList({ env: ENV, fetch: trello.fetch });
    await post(app, "/shopping/remove", { weekStart: WEEK, name: "ost" });
    trello.calls.length = 0;

    await app.inject({ method: "POST", url: "/shopping/push", payload: { weekStart: WEEK } });

    expect(trello.cardNames()).toEqual(["500 g pasta"]);
  });
});

describe("Checked Off lines", () => {
  it("shows a tick control on every Buy and Check pantry line", async () => {
    const { app } = await builtList();

    const html = await shoppingPage(app);

    for (const name of ["pasta", "ost", "mjölk"]) {
      expect(html).toMatch(new RegExp(`<form method="post" action="/shopping/check">[\\s\\S]*?name="name" value="${name}"`));
    }
    expect(lines(html, "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
    expect(lines(html, "check-pantry")).toEqual([["2 dl mjölk", false]]);
  });

  it("POST check strikes the line through and sorts it after the unchecked lines; uncheck reverses it", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/check", { weekStart: WEEK, name: "pasta" });
    const checked = await shoppingPage(app);
    await post(app, "/shopping/uncheck", { weekStart: WEEK, name: "pasta" });
    const unchecked = await shoppingPage(app);

    expect(lines(checked, "buy")).toEqual([["ost", false], ["500 g pasta", true]]);
    expect(checked).toMatch(/<li class="row line line-checked">[\s\S]*?action="\/shopping\/uncheck"[\s\S]*?<s class="row-label">500 g pasta<\/s>/);
    expect(lines(unchecked, "buy")).toEqual([["500 g pasta", false], ["ost", false]]);
  });

  it("a tick does not mark the sent list as changed, but an Extra Item does", async () => {
    const trello = trelloRecorder();
    const { app } = await builtList({ env: ENV, fetch: trello.fetch });
    const changed = "The list has changed since it was sent.";
    expect(await shoppingPage(app)).toContain("Sent to Trello");

    await post(app, "/shopping/check", { weekStart: WEEK, name: "pasta" });
    const ticked = await shoppingPage(app);
    await post(app, "/shopping/extra", { weekStart: WEEK, name: "batteries" });
    const extended = await shoppingPage(app);

    expect(lines(ticked, "buy")).toEqual([["ost", false], ["500 g pasta", true]]);
    expect(ticked).not.toContain(changed);
    expect(extended).toContain(changed);
  });

  it("Check pantry lines are tickable too", async () => {
    const { app } = await builtList();

    await post(app, "/shopping/check", { weekStart: WEEK, name: "Mjölk" });

    expect(lines(await shoppingPage(app), "check-pantry")).toEqual([["2 dl mjölk", true]]);
  });

  it("keeps the tick on a surviving line through a rebuild", async () => {
    const { app } = await builtList();
    await post(app, "/shopping/check", { weekStart: WEEK, name: "ost" });

    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });

    expect(lines(await shoppingPage(app), "buy")).toEqual([["500 g pasta", false], ["ost", true]]);
  });

  it("is per week: the same Ingredient in another week's list is unaffected", async () => {
    const { app, pasta } = await builtList();
    planWith(app, NEXT_WEEK, [pasta]);
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: NEXT_WEEK } });

    await post(app, "/shopping/check", { weekStart: WEEK, name: "pasta" });

    expect(lines(await shoppingPage(app, WEEK), "buy")[1]).toEqual(["500 g pasta", true]);
    expect(lines(await shoppingPage(app, NEXT_WEEK), "buy")).toEqual([["400 g pasta", false]]);
  });
});
