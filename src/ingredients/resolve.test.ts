import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { createDish, getDish } from "../dishes/repo.js";
import { ScriptedLlmAgent } from "../llm/index.js";
import { resolveIngredients, resolveWeek } from "./resolve.js";

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

  it("a Dish with neither manual Ingredients nor a URL resolves to source none (FR-2; #30 adds the LLM-found recipe)", async () => {
    const db = freshDb();
    const id = createDish(db, { name: "Burgers" });
    const llm = new ScriptedLlmAgent({ findRecipe: { ok: true, value: { url: "x", ingredients: [{ name: "buns" }] } } });

    const result = await resolveIngredients({ db, llm, fetchPage: fetcher({}) }, getDish(db, id)!);

    expect(result).toEqual({ ingredients: [], source: "none" });
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
