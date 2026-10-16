import { describe, expect, it } from "vitest";
import { ScriptedLlmAgent } from "../llm/index.js";
import { matchPantry, normaliseName } from "./matching.js";
import type { PantryItem } from "./repo.js";

const milk: PantryItem = { id: 1, name: "mjölk", aliases: ["milk"] };
const flour: PantryItem = { id: 2, name: "flour", aliases: ["mjöl", "vetemjöl"] };
const pantry = [milk, flour];

describe("normaliseName", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normaliseName("  Whole \t  Milk ")).toBe("whole milk");
  });
});

describe("matchPantry", () => {
  it("matches an Ingredient to a Pantry Item by alias without calling the LLM", async () => {
    const llm = new ScriptedLlmAgent();

    const result = await matchPantry(["Milk"], pantry, llm);

    expect(result.get("Milk")).toEqual(milk);
    expect(llm.calls).toHaveLength(0);
  });

  it("matches the other direction too: an Ingredient named like the item, item alias in the other language", async () => {
    const llm = new ScriptedLlmAgent();
    const swedishMilk: PantryItem = { id: 3, name: "milk", aliases: ["mjölk"] };

    const result = await matchPantry(["mjölk", "MILK"], [swedishMilk], llm);

    expect(result.get("mjölk")).toEqual(swedishMilk);
    expect(result.get("MILK")).toEqual(swedishMilk);
    expect(llm.calls).toHaveLength(0);
  });

  it("sends only the unmatched Ingredients to the LLM in one call and applies its matches", async () => {
    const llm = new ScriptedLlmAgent({
      matchPantryItems: {
        ok: true,
        value: [
          { ingredient: "whole milk", pantryId: "1" },
          { ingredient: "saffron", pantryId: null },
        ],
      },
    });

    const result = await matchPantry(["milk", "whole milk", "saffron"], pantry, llm);

    expect(result.get("milk")).toEqual(milk);
    expect(result.get("whole milk")).toEqual(milk);
    expect(result.get("saffron")).toBeNull();
    expect(llm.calls).toEqual([
      {
        method: "matchPantryItems",
        args: [
          {
            ingredients: ["whole milk", "saffron"],
            pantry: [
              { id: "1", name: "mjölk", aliases: ["milk"] },
              { id: "2", name: "flour", aliases: ["mjöl", "vetemjöl"] },
            ],
          },
        ],
      },
    ]);
  });

  it("leaves every unmatched Ingredient in Buy when the LLM degrades", async () => {
    const llm = new ScriptedLlmAgent();

    const result = await matchPantry(["milk", "saffron"], pantry, llm);

    expect(result.get("milk")).toEqual(milk);
    expect(result.get("saffron")).toBeNull();
    expect(llm.calls).toHaveLength(1);
  });

  it("ignores LLM answers for ingredients it was not asked about or pantry ids it does not know", async () => {
    const llm = new ScriptedLlmAgent({
      matchPantryItems: {
        ok: true,
        value: [
          { ingredient: "milk", pantryId: "2" },
          { ingredient: "saffron", pantryId: "99" },
        ],
      },
    });

    const result = await matchPantry(["milk", "saffron"], pantry, llm);

    expect(result.get("milk")).toEqual(milk);
    expect(result.get("saffron")).toBeNull();
  });

  it("does not call the LLM when everything matched deterministically or the pantry is empty", async () => {
    const llm = new ScriptedLlmAgent();

    const allMatched = await matchPantry(["milk", "mjöl"], pantry, llm);
    const emptyPantry = await matchPantry(["saffron"], [], llm);

    expect(allMatched.get("mjöl")).toEqual(flour);
    expect(emptyPantry.get("saffron")).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});
