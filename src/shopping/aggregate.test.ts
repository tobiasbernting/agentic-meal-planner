import { describe, expect, it } from "vitest";
import { aggregateIngredients } from "./aggregate.js";

describe("aggregateIngredients", () => {
  it("merges duplicate Ingredients by normalised name and sums quantities with the same unit", () => {
    const items = aggregateIngredients([
      { dishId: 1, ingredients: [{ name: "Mjölk", quantity: 2, unit: "dl" }] },
      { dishId: 2, ingredients: [{ name: " mjölk ", quantity: 1.5, unit: "dl" }] },
    ]);

    expect(items).toEqual([{ name: "Mjölk", quantity: "3.5", unit: "dl", sourceDishIds: [1, 2] }]);
  });

  it("keeps separate quantity notes when units differ or are missing", () => {
    const items = aggregateIngredients([
      { dishId: 1, ingredients: [{ name: "smör", quantity: 2, unit: "dl" }] },
      { dishId: 2, ingredients: [{ name: "Smör", quantity: 1, unit: "msk" }] },
      { dishId: 3, ingredients: [{ name: "smör", quantity: null, unit: null }] },
      { dishId: 4, ingredients: [{ name: "smör", quantity: 1, unit: null }] },
    ]);

    expect(items).toEqual([{ name: "smör", quantity: "2 dl + 1 msk + 1", unit: null, sourceDishIds: [1, 2, 3, 4] }]);
  });

  it("gives an Ingredient with no quantities a null quantity and lists one source Dish once", () => {
    const items = aggregateIngredients([
      { dishId: 7, ingredients: [{ name: "salt", quantity: null, unit: null }, { name: "Salt", quantity: null, unit: "nypa" }] },
    ]);

    expect(items).toEqual([{ name: "salt", quantity: null, unit: null, sourceDishIds: [7] }]);
  });

  it("keeps first-seen order and an empty week is an empty list", () => {
    expect(aggregateIngredients([])).toEqual([]);
    const items = aggregateIngredients([
      { dishId: 1, ingredients: [{ name: "lök", quantity: 1, unit: null }, { name: "ris", quantity: 3, unit: "dl" }] },
      { dishId: 2, ingredients: [{ name: "lök", quantity: 2, unit: null }] },
    ]);
    expect(items.map((i) => i.name)).toEqual(["lök", "ris"]);
    expect(items[0]).toMatchObject({ quantity: "3", unit: null });
  });
});
