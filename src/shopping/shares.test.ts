import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { createDish, deleteDish } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent } from "../llm/index.js";
import { createPantryItem } from "../pantry/repo.js";
import { listItems, setChecked } from "../lists/repo.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { getPlanForWeek, setPlannedDinnerDish } from "../planner/repo.js";
import { getShoppingList } from "./list.js";
import { addLine, deleteLine } from "./edits.js";
import { listMissingDinners, updateShoppingList } from "./shares.js";
import { planWeek } from "./test-helpers.js";

const WEEK = "2026-10-19";
const NEXT_WEEK = "2026-10-26";
const NOW = new Date("2026-10-18T18:00:00Z");

const noFetch = async (url: string): Promise<string> => {
  throw new Error(`unexpected fetch ${url}`);
};

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "shopping-shares-")));
}

function deps(db: ReturnType<typeof freshDb>, llm = new NoAgent()) {
  return { db, llm, fetchPage: noFetch, now: () => NOW };
}

/** [label, checked] per section, as the page would show them. */
function lines(db: ReturnType<typeof freshDb>) {
  const { buy, checkPantry } = getShoppingList(db);
  const show = (l: (typeof buy)[number]) => `${l.quantity === null ? "" : `${l.quantity}${l.unit ? ` ${l.unit}` : ""} `}${l.name}${l.checked ? " ✓" : ""}`;
  return { buy: buy.map(show), checkPantry: checkPantry.map(show) };
}

describe("updateShoppingList", () => {
  it("adds one Share per Ingredient of each Planned Dinner, merging the same Ingredient from two dinners, split by pantry", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "Mjölk", quantity: 2, unit: "dl" }, { name: "pasta", quantity: 400, unit: "g" }] });
    const pancakes = createDish(db, { name: "Pannkakor", ingredients: [{ name: "mjölk", quantity: 6, unit: "dl" }, { name: "ägg", quantity: 3, unit: null }] });
    createPantryItem(db, { name: "milk", aliases: ["mjölk"] });
    const planId = planWeek(db, WEEK, [pasta, pancakes, null], NOW.toISOString());

    const result = await updateShoppingList(deps(db), planId);

    expect(result).toMatchObject({ added: 2, missingDinnerIds: [], degradedReasons: [] });
    expect(lines(db)).toEqual({ buy: ["400 g pasta", "3 ägg"], checkPantry: ["8 dl Mjölk"] });
    const milk = getShoppingList(db).checkPantry[0]!;
    expect(milk.dinners.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(milk.sourceDishIds).toEqual([pasta, pancakes]);
  });

  it("is a no-op for dinners that already have Shares, so running twice changes nothing", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
    const planId = planWeek(db, WEEK, [pasta], NOW.toISOString());

    await updateShoppingList(deps(db), planId);
    const second = await updateShoppingList(deps(db), planId);

    expect(second.added).toBe(0);
    expect(lines(db).buy).toEqual(["400 g pasta"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shopping_share").get()).toEqual({ n: 1 });
  });

  it("keeps a tick through a re-run and across weeks, and un-ticks only when more is needed", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    const gratin = createDish(db, { name: "Gratäng", ingredients: [{ name: "pasta", quantity: 100, unit: "g" }] });
    const planId = planWeek(db, WEEK, [pasta], NOW.toISOString());
    await updateShoppingList(deps(db), planId);
    const [pastaLine, ostLine] = listItems(db, SHOPPING_LIST_ID);
    setChecked(db, pastaLine!.id, NOW.toISOString());
    setChecked(db, ostLine!.id, NOW.toISOString());

    await updateShoppingList(deps(db), planId);
    expect(lines(db).buy).toEqual(["400 g pasta ✓", "ost ✓"]);

    const nextPlan = planWeek(db, NEXT_WEEK, [gratin], NOW.toISOString());
    await updateShoppingList(deps(db), nextPlan);

    expect(lines(db).buy).toEqual(["500 g pasta", "ost ✓"]);
  });

  it("withdraws the old Dish's Shares on a Swap: unique lines go, shared lines shrink, the new Dish's lines come", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    const gratin = createDish(db, { name: "Gratäng", ingredients: [{ name: "pasta", quantity: 100, unit: "g" }, { name: "grädde", quantity: 2, unit: "dl" }] });
    const pizza = createDish(db, { name: "Pizza", ingredients: [{ name: "mozzarella", quantity: 2, unit: "st" }] });
    const planId = planWeek(db, WEEK, [pasta, gratin], NOW.toISOString());
    await updateShoppingList(deps(db), planId);
    expect(lines(db).buy).toEqual(["500 g pasta", "ost", "2 dl grädde"]);

    setPlannedDinnerDish(db, planId, "2026-10-20", pizza, "by hand");
    await updateShoppingList(deps(db), planId);

    expect(lines(db).buy).toEqual(["400 g pasta", "ost", "2 st mozzarella"]);
  });

  it("keeps a ticked line whose last Share is withdrawn, as hand-added, and deletes an unticked one", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    const pizza = createDish(db, { name: "Pizza", ingredients: [{ name: "mozzarella", quantity: 2, unit: "st" }] });
    const planId = planWeek(db, WEEK, [pasta], NOW.toISOString());
    await updateShoppingList(deps(db), planId);
    setChecked(db, listItems(db, SHOPPING_LIST_ID)[1]!.id, NOW.toISOString());

    setPlannedDinnerDish(db, planId, WEEK, pizza, "by hand");
    await updateShoppingList(deps(db), planId);

    expect(lines(db).buy).toEqual(["2 st mozzarella", "ost ✓"]);
    expect(getShoppingList(db).buy.find((l) => l.name === "ost")).toMatchObject({ handAdded: true, dinners: [] });
  });

  it("survives a regenerate: new dinner rows for the same Dish keep the line and its tick", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
    const planId = planWeek(db, WEEK, [pasta], NOW.toISOString());
    await updateShoppingList(deps(db), planId);
    setChecked(db, listItems(db, SHOPPING_LIST_ID)[0]!.id, NOW.toISOString());

    const regenerated = planWeek(db, WEEK, [pasta], NOW.toISOString());
    await updateShoppingList(deps(db), regenerated);

    expect(regenerated).not.toBe(planId);
    expect(lines(db).buy).toEqual(["400 g pasta ✓"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shopping_share").get()).toEqual({ n: 1 });
  });

  it("does not bring a Deleted line back: its Shares stay as tombstones", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    const planId = planWeek(db, WEEK, [pasta], NOW.toISOString());
    await updateShoppingList(deps(db), planId);

    deleteLine(db, listItems(db, SHOPPING_LIST_ID)[1]!.id);
    await updateShoppingList(deps(db), planId);

    expect(lines(db).buy).toEqual(["400 g pasta"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shopping_share WHERE list_item_id IS NULL").get()).toEqual({ n: 1 });
  });

  it("withdraws the Shares of a deleted Dish's dinners", async () => {
    const db = freshDb();
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
    const toast = createDish(db, { name: "Toast", ingredients: [{ name: "bröd", quantity: null, unit: null }] });
    const planId = planWeek(db, WEEK, [pasta, toast], NOW.toISOString());
    await updateShoppingList(deps(db), planId);

    deleteDish(db, pasta);
    await updateShoppingList(deps(db), planId);

    expect(lines(db).buy).toEqual(["bröd"]);
    expect(getPlanForWeek(db, WEEK)?.dinners[0]?.dishId).toBeNull();
  });

  it("records a dinner with no Ingredients as missing and resolves it fresh on request", async () => {
    const db = freshDb();
    const state = { works: false };
    const llm = new ScriptedLlmAgent({
      findRecipe: (name) => (state.works ? { ok: true, value: { url: `https://r.example/${name}`, ingredients: [{ name: "ärtor", quantity: 500, unit: "g" }] } } : { ok: false, reason: "agent refused" }),
    });
    const soup = createDish(db, { name: "Soppa" });
    const planId = planWeek(db, WEEK, [soup], NOW.toISOString());

    const first = await updateShoppingList(deps(db, llm), planId);
    expect(first.degradedReasons).toEqual(["Soppa: agent refused"]);
    expect(listMissingDinners(db).map((d) => d.dishId)).toEqual([soup]);
    expect(lines(db).buy).toEqual([]);

    state.works = true;
    await updateShoppingList(deps(db, llm), planId, new Set(listMissingDinners(db).map((d) => d.id)));

    expect(listMissingDinners(db)).toEqual([]);
    expect(lines(db).buy).toEqual(["500 g ärtor"]);
  });

  it("un-ticks a hand-added line when a Share lands on it, and keeps its free text", async () => {
    const db = freshDb();
    addLine(db, { name: "Pasta", quantity: "1 pkt" }, NOW.toISOString());
    setChecked(db, listItems(db, SHOPPING_LIST_ID)[0]!.id, NOW.toISOString());
    const pasta = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
    const planId = planWeek(db, WEEK, [pasta], NOW.toISOString());

    await updateShoppingList(deps(db), planId);

    expect(lines(db).buy).toEqual(["400 g + 1 pkt Pasta"]);
  });
});
