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
