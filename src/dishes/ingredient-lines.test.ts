import { describe, expect, it } from "vitest";
import { formatIngredientLines, parseIngredientLines } from "./routes.js";

describe("manual Ingredient lines (name | quantity | unit)", () => {
  it("parses optional quantity and unit, accepting a Swedish decimal comma", () => {
    expect(parseIngredientLines("cream | 2,5 | dl\n\n  pasta | 400 | g  \nsalt\n")).toEqual([
      { name: "cream", quantity: 2.5, unit: "dl" },
      { name: "pasta", quantity: 400, unit: "g" },
      { name: "salt", quantity: null, unit: null },
    ]);
  });

  it("keeps a non-numeric quantity as the unit instead of dropping it", () => {
    expect(parseIngredientLines("chili | a pinch")).toEqual([{ name: "chili", quantity: null, unit: "a pinch" }]);
  });

  it("formats back to the same lines the user typed", () => {
    const lines = "cream | 2.5 | dl\npasta | 400 | g\ntortillas | 8\nsalt";

    expect(formatIngredientLines(parseIngredientLines(lines))).toBe(lines);
  });
});
