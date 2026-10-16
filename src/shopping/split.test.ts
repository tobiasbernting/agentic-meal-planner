import { describe, expect, it } from "vitest";
import type { PantryItem } from "../pantry/repo.js";
import type { AggregatedItem } from "./aggregate.js";
import { splitSections } from "./split.js";

const milk: PantryItem = { id: 1, name: "mjölk", aliases: ["milk"] };

function item(name: string): AggregatedItem {
  return { name, quantity: null, unit: null, sourceDishIds: [1] };
}

describe("splitSections", () => {
  it("puts Pantry Item matches in Check pantry and everything else in Buy, never both", () => {
    const items = [item("Milk"), item("saffron"), item("flour")];
    const matches = new Map<string, PantryItem | null>([
      ["Milk", milk],
      ["saffron", null],
    ]);

    const { buy, checkPantry } = splitSections(items, matches);

    expect(checkPantry.map((i) => i.name)).toEqual(["Milk"]);
    expect(buy.map((i) => i.name)).toEqual(["saffron", "flour"]);
    for (const i of checkPantry) expect(buy).not.toContainEqual(i);
  });
});
