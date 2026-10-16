import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createDish, getDish } from "../dishes/repo.js";
import { ScriptedLlmAgent } from "../llm/index.js";
import { getPlanForWeek, savePlan } from "../planner/repo.js";
import { weekDates } from "../week.js";
import { resolveIngredients, resolvePlanIngredients, resolveWeek } from "./resolve.js";

const dbs: Database.Database[] = [];

function freshDb() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "mp-ingredients-")));
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

const RECIPE_URL = "https://recipes.example/pancakes";
const RECIPE_PAGE = "<html>Pancakes: 3 dl flour, 2 eggs, 6 dl milk, chili</html>";
const FOUND_URL = "https://recipes.example/burgers";

function fetcher(pages: Record<string, string>, fetched: string[] = []) {
  return async (url: string) => {
    fetched.push(url);
    const page = pages[url];
    if (page === undefined) throw new Error(`no fixture for ${url}`);
    return page;
  };
}

describe("resolveIngredients", () => {
  it("manual Ingredients win over a recipe URL: nothing is fetched or extracted", async () => {
    const db = freshDb();
    const id = createDish(db, {
      name: "Pancakes",
      recipeUrl: RECIPE_URL,
      ingredients: [
        { name: "flour", quantity: 3, unit: "dl" },
        { name: "eggs", quantity: 2, unit: null },
      ],
    });
    const llm = new ScriptedLlmAgent({ extractIngredients: { ok: true, value: [{ name: "from the url" }] } });
    const fetched: string[] = [];

    const result = await resolveIngredients({ db, llm, fetchPage: fetcher({ [RECIPE_URL]: RECIPE_PAGE }, fetched) }, getDish(db, id)!);

    expect(result).toEqual({
      ingredients: [
        { name: "flour", quantity: 3, unit: "dl" },
        { name: "eggs", quantity: 2, unit: null },
      ],
      source: "manual",
    });
    expect(fetched).toEqual([]);
    expect(llm.calls).toEqual([]);
  });

  it("extracts from the recipe URL and normalises the LLM Ingredients to the Dish shape", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Pancakes", recipeUrl: RECIPE_URL });
    const llm = new ScriptedLlmAgent({
      extractIngredients: {
        ok: true,
        value: [
          { name: "flour", quantity: 3, unit: "dl" },
          { name: "eggs", quantity: "2" },
          { name: "milk", quantity: "6,5", unit: "dl" },
          { name: "salt" },
        ],
      },
    });

    const result = await resolveIngredients({ db, llm, fetchPage: fetcher({ [RECIPE_URL]: RECIPE_PAGE }) }, getDish(db, id)!);

    expect(result).toEqual({
      ingredients: [
        { name: "flour", quantity: 3, unit: "dl" },
        { name: "eggs", quantity: 2, unit: null },
        { name: "milk", quantity: 6.5, unit: "dl" },
        { name: "salt", quantity: null, unit: null },
      ],
      source: "url",
      sourceUrl: RECIPE_URL,
    });
    expect(llm.calls).toEqual([{ method: "extractIngredients", args: [RECIPE_PAGE, { adaptationNotes: undefined }] }]);
  });

  it("fetches a URL on every resolve but extracts once per content hash", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Pancakes", recipeUrl: RECIPE_URL });
    const pages = { [RECIPE_URL]: RECIPE_PAGE };
    const fetched: string[] = [];
    const extracted: string[] = [];
    const llm = new ScriptedLlmAgent({
      extractIngredients: (page) => {
        extracted.push(page);
        return { ok: true, value: [{ name: page.includes("chili") ? "chili" : "no chili" }] };
      },
    });
    const deps = { db, llm, fetchPage: fetcher(pages, fetched) };
    const dish = getDish(db, id)!;

    const first = await resolveIngredients(deps, dish);
    const second = await resolveIngredients(deps, dish);
    pages[RECIPE_URL] = "<html>Pancakes v2: flour, eggs, milk</html>";
    const third = await resolveIngredients(deps, dish);

    expect(first.ingredients).toEqual([{ name: "chili", quantity: null, unit: null }]);
    expect(second).toEqual(first);
    expect(third.ingredients).toEqual([{ name: "no chili", quantity: null, unit: null }]);
    expect(fetched).toHaveLength(3);
    expect(extracted).toEqual([RECIPE_PAGE, "<html>Pancakes v2: flour, eggs, milk</html>"]);
  });

  it("an Adaptation changes the extracted list and is part of the cache key", async () => {
    const db = freshDb();
    const plain = createDish(db, { name: "Pancakes", recipeUrl: RECIPE_URL });
    const adapted = createDish(db, { name: "Kids' pancakes", recipeUrl: RECIPE_URL, adaptationNotes: "no chili — the kids" });
    const llm = new ScriptedLlmAgent({
      extractIngredients: (_page, { adaptationNotes }) => ({
        ok: true,
        value: adaptationNotes ? [{ name: "flour" }, { name: "eggs" }] : [{ name: "flour" }, { name: "eggs" }, { name: "chili" }],
      }),
    });
    const deps = { db, llm, fetchPage: fetcher({ [RECIPE_URL]: RECIPE_PAGE }) };

    const plainResult = await resolveIngredients(deps, getDish(db, plain)!);
    const adaptedResult = await resolveIngredients(deps, getDish(db, adapted)!);
    const adaptedAgain = await resolveIngredients(deps, getDish(db, adapted)!);

    expect(plainResult.ingredients.map((i) => i.name)).toEqual(["flour", "eggs", "chili"]);
    expect(adaptedResult.ingredients.map((i) => i.name)).toEqual(["flour", "eggs"]);
    expect(adaptedAgain).toEqual(adaptedResult);
    expect(llm.calls.map((c) => c.args[1])).toEqual([
      { adaptationNotes: undefined },
      { adaptationNotes: "no chili — the kids" },
    ]);
  });

  it("degrades with the agent's reason when extraction fails, and retries on the next resolve", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Pancakes", recipeUrl: RECIPE_URL });
    const llm = new ScriptedLlmAgent();
    const deps = { db, llm, fetchPage: fetcher({ [RECIPE_URL]: RECIPE_PAGE }) };

    const result = await resolveIngredients(deps, getDish(db, id)!);
    await resolveIngredients(deps, getDish(db, id)!);

    expect(result).toEqual({
      ingredients: [],
      source: "url",
      sourceUrl: RECIPE_URL,
      degradedReason: "no scripted response for extractIngredients",
    });
    expect(llm.calls).toHaveLength(2);
  });

  it("degrades when the recipe page cannot be fetched", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Pancakes", recipeUrl: "https://down.example/recipe" });
    const llm = new ScriptedLlmAgent({ extractIngredients: { ok: true, value: [{ name: "flour" }] } });

    const result = await resolveIngredients({ db, llm, fetchPage: fetcher({}) }, getDish(db, id)!);

    expect(result).toEqual({
      ingredients: [],
      source: "url",
      sourceUrl: "https://down.example/recipe",
      degradedReason: "fetch failed: no fixture for https://down.example/recipe",
    });
    expect(llm.calls).toEqual([]);
  });

  it("a Dish with neither manual Ingredients nor a URL gets an LLM-found recipe (FR-2) with its source link", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Burgers" });
    const llm = new ScriptedLlmAgent({
      findRecipe: {
        ok: true,
        value: { url: FOUND_URL, ingredients: [{ name: "buns", quantity: "4" }, { name: "minced beef", quantity: 500, unit: "g" }] },
      },
    });
    const fetched: string[] = [];

    const result = await resolveIngredients({ db, llm, fetchPage: fetcher({}, fetched) }, getDish(db, id)!);

    expect(result).toEqual({
      ingredients: [
        { name: "buns", quantity: 4, unit: null },
        { name: "minced beef", quantity: 500, unit: "g" },
      ],
      source: "llm",
      sourceUrl: FOUND_URL,
    });
    expect(fetched).toEqual([]);
    expect(llm.calls).toEqual([{ method: "findRecipe", args: ["Burgers", { adaptationNotes: undefined }] }]);
  });

  it("degrades to source none with the agent's reason when no recipe is found, and retries next resolve", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Burgers" });
    const llm = new ScriptedLlmAgent();
    const deps = { db, llm, fetchPage: fetcher({}) };

    const result = await resolveIngredients(deps, getDish(db, id)!);
    await resolveIngredients(deps, getDish(db, id)!);

    expect(result).toEqual({ ingredients: [], source: "none", degradedReason: "no scripted response for findRecipe" });
    expect(llm.calls).toHaveLength(2);
  });

  it("searches once per Dish name and Adaptation: a repeated week reuses the found recipe", async () => {
    const db = freshDb();
    const plain = createDish(db, { name: "Burgers" });
    const adapted = createDish(db, { name: "Burgers", adaptationNotes: "no pickles — the kids" });
    const llm = new ScriptedLlmAgent({
      findRecipe: (_name, { adaptationNotes }) => ({
        ok: true,
        value: { url: FOUND_URL, ingredients: adaptationNotes ? [{ name: "buns" }] : [{ name: "buns" }, { name: "pickles" }] },
      }),
    });
    const deps = { db, llm, fetchPage: fetcher({}) };

    const first = await resolveIngredients(deps, getDish(db, plain)!);
    const again = await resolveIngredients(deps, getDish(db, plain)!);
    const adaptedResult = await resolveIngredients(deps, getDish(db, adapted)!);
    const adaptedAgain = await resolveIngredients(deps, getDish(db, adapted)!);

    expect(first).toEqual({ ingredients: [{ name: "buns", quantity: null, unit: null }, { name: "pickles", quantity: null, unit: null }], source: "llm", sourceUrl: FOUND_URL });
    expect(again).toEqual(first);
    expect(adaptedResult.ingredients.map((i) => i.name)).toEqual(["buns"]);
    expect(adaptedAgain).toEqual(adaptedResult);
    expect(llm.calls.map((c) => c.args)).toEqual([
      ["Burgers", { adaptationNotes: undefined }],
      ["Burgers", { adaptationNotes: "no pickles — the kids" }],
    ]);
  });
});

describe("resolvePlanIngredients", () => {
  it("resolves every Planned Dinner with a Dish, in date order, and stores the LLM-found source link on the dinner", async () => {
    const db = freshDb();
    const tacos = createDish(db, { name: "Tacos", ingredients: [{ name: "tortillas", quantity: null, unit: null }] });
    const pancakes = createDish(db, { name: "Pancakes", recipeUrl: RECIPE_URL });
    const burgers = createDish(db, { name: "Burgers" });
    const dates = weekDates("2026-10-12");
    const planId = savePlan(
      db,
      {
        weekStart: "2026-10-12",
        degradedReasons: [],
        dinners: dates.map((date, i) => ({
          date,
          dishId: [burgers, null, tacos, pancakes, burgers, null, null][i]!,
          isQuickDay: false,
          lunchThatDay: null,
          rationale: "r",
        })),
      },
      "2026-10-11T18:00:00.000Z",
    );
    const llm = new ScriptedLlmAgent({
      extractIngredients: { ok: true, value: [{ name: "flour" }] },
      findRecipe: { ok: true, value: { url: FOUND_URL, ingredients: [{ name: "buns" }] } },
    });

    const results = await resolvePlanIngredients({ db, llm, fetchPage: fetcher({ [RECIPE_URL]: RECIPE_PAGE }) }, planId);

    expect(results.map((r) => [r.dinner.date, r.dish.name, r.resolved.source, r.resolved.ingredients.map((i) => i.name)])).toEqual([
      ["2026-10-12", "Burgers", "llm", ["buns"]],
      ["2026-10-14", "Tacos", "manual", ["tortillas"]],
      ["2026-10-15", "Pancakes", "url", ["flour"]],
      ["2026-10-16", "Burgers", "llm", ["buns"]],
    ]);
    expect(results.map((r) => r.dinner.sourceUrl)).toEqual([FOUND_URL, null, null, FOUND_URL]);
    expect(getPlanForWeek(db, "2026-10-12")!.dinners.map((d) => d.sourceUrl)).toEqual([FOUND_URL, null, null, null, FOUND_URL, null, null]);
    expect(llm.calls.filter((c) => c.method === "findRecipe")).toHaveLength(1);
  });

  it("returns an empty list for an unknown plan", async () => {
    const db = freshDb();
    expect(await resolvePlanIngredients({ db, llm: new ScriptedLlmAgent(), fetchPage: fetcher({}) }, 999)).toEqual([]);
  });
});

describe("resolveWeek", () => {
  it("returns one result per Dish in input order", async () => {
    const db = freshDb();
    const manual = createDish(db, { name: "Tacos", ingredients: [{ name: "tortillas", quantity: null, unit: null }] });
    const fromUrl = createDish(db, { name: "Pancakes", recipeUrl: RECIPE_URL });
    const none = createDish(db, { name: "Burgers" });
    const llm = new ScriptedLlmAgent({ extractIngredients: { ok: true, value: [{ name: "flour" }] } });
    const dishes = [getDish(db, fromUrl)!, getDish(db, manual)!, getDish(db, none)!];

    const results = await resolveWeek({ db, llm, fetchPage: fetcher({ [RECIPE_URL]: RECIPE_PAGE }) }, dishes);

    expect(results.map((r) => [r.source, r.ingredients.map((i) => i.name)])).toEqual([
      ["url", ["flour"]],
      ["manual", ["tortillas"]],
      ["none", []],
    ]);
  });
});
