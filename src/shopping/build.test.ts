import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { createDish } from "../dishes/repo.js";
import { NO_AGENT_REASON, NoAgent, ScriptedLlmAgent } from "../llm/index.js";
import { createPantryItem } from "../pantry/repo.js";
import { NO_ELIGIBLE_DISH_RATIONALE } from "../planner/plan-week.js";
import { listPlannedDinners, savePlan } from "../planner/repo.js";
import { buildShoppingList, getShoppingList } from "./build.js";

const WEEK = "2026-10-19";
const NOW = new Date("2026-10-18T18:00:00Z");

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "shopping-build-")));
}

const noFetch = async (url: string): Promise<string> => {
  throw new Error(`unexpected fetch ${url}`);
};

describe("buildShoppingList", () => {
  it("aggregates the week's Planned Dinners, splits by pantry, stores and returns the list", async () => {
    const db = freshDb();
    const pasta = createDish(db, {
      name: "Pasta",
      ingredients: [
        { name: "Mjölk", quantity: 2, unit: "dl" },
        { name: "pasta", quantity: 400, unit: "g" },
      ],
    });
    const pancakes = createDish(db, {
      name: "Pannkakor",
      ingredients: [
        { name: "mjölk", quantity: 6, unit: "dl" },
        { name: "ägg", quantity: 3, unit: null },
      ],
    });
    createPantryItem(db, { name: "milk", aliases: ["mjölk"] });
    const planId = savePlan(
      db,
      {
        weekStart: WEEK,
        dinners: [
          { date: "2026-10-19", dishId: pasta, isQuickDay: false, lunchThatDay: null, rationale: "r" },
          { date: "2026-10-20", dishId: pancakes, isQuickDay: false, lunchThatDay: null, rationale: "r" },
          { date: "2026-10-21", dishId: null, isQuickDay: false, lunchThatDay: null, rationale: NO_ELIGIBLE_DISH_RATIONALE },
        ],
        degradedReasons: [],
      },
      NOW.toISOString(),
    );
    const llm = new ScriptedLlmAgent({
      matchPantryItems: { ok: true, value: [{ ingredient: "pasta", pantryId: null }, { ingredient: "ägg", pantryId: null }] },
    });

    const list = await buildShoppingList({ db, llm, fetchPage: noFetch, now: () => NOW }, planId);

    expect(list.checkPantry).toEqual([{ name: "Mjölk", quantity: "8", unit: "dl", sourceDishIds: [pasta, pancakes] }]);
    expect(list.buy).toEqual([
      { name: "pasta", quantity: "400", unit: "g", sourceDishIds: [pasta] },
      { name: "ägg", quantity: "3", unit: null, sourceDishIds: [pancakes] },
    ]);
    expect(list.degradedReasons).toEqual([]);
    expect(getShoppingList(db, planId)).toEqual({ buy: list.buy, checkPantry: list.checkPantry });
  });

  it("replaces the stored list on rebuild and reports degraded resolution without an agent", async () => {
    const db = freshDb();
    const toast = createDish(db, { name: "Toast", ingredients: [{ name: "bröd", quantity: 1, unit: null }] });
    const fromUrl = createDish(db, { name: "Mystery", recipeUrl: "https://recipes.test/mystery" });
    const planId = savePlan(
      db,
      {
        weekStart: WEEK,
        dinners: [
          { date: "2026-10-19", dishId: toast, isQuickDay: false, lunchThatDay: null, rationale: "r" },
          { date: "2026-10-20", dishId: fromUrl, isQuickDay: false, lunchThatDay: null, rationale: "r" },
        ],
        degradedReasons: [],
      },
      NOW.toISOString(),
    );
    const deps = { db, llm: new NoAgent(), fetchPage: async () => "<html>recipe</html>", now: () => NOW };

    const first = await buildShoppingList(deps, planId);
    const second = await buildShoppingList(deps, planId);

    expect(first.buy.map((i) => i.name)).toEqual(["bröd"]);
    expect(first.checkPantry).toEqual([]);
    expect(first.degradedReasons).toEqual([`Mystery: ${NO_AGENT_REASON}`]);
    expect(second).toEqual(first);
    expect(getShoppingList(db, planId).buy).toHaveLength(1);
  });

  it("puts an LLM-found recipe's Ingredients on the list and records its source link on the Planned Dinner (#30)", async () => {
    const db = freshDb();
    const burgers = createDish(db, { name: "Burgers" });
    const planId = savePlan(
      db,
      {
        weekStart: WEEK,
        dinners: [{ date: "2026-10-19", dishId: burgers, isQuickDay: false, lunchThatDay: null, rationale: "r" }],
        degradedReasons: [],
      },
      NOW.toISOString(),
    );
    const llm = new ScriptedLlmAgent({
      findRecipe: { ok: true, value: { url: "https://recipes.test/burgers", ingredients: [{ name: "buns", quantity: "4" }] } },
      matchPantryItems: { ok: true, value: [{ ingredient: "buns", pantryId: null }] },
    });

    const list = await buildShoppingList({ db, llm, fetchPage: noFetch, now: () => NOW }, planId);

    expect(list.buy).toEqual([{ name: "buns", quantity: "4", unit: null, sourceDishIds: [burgers] }]);
    expect(list.degradedReasons).toEqual([]);
    expect(listPlannedDinners(db, planId)[0]!.sourceUrl).toBe("https://recipes.test/burgers");
  });

  it("is empty for a plan that has not been built", () => {
    const db = freshDb();
    expect(getShoppingList(db, 999)).toEqual({ buy: [], checkPantry: [] });
  });
});
