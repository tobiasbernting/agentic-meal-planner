import { describe, expect, it } from "vitest";
import { combineParts, lineQuantity, needsMore } from "./quantity.js";

describe("combineParts", () => {
  it("sums parts that share one unit", () => {
    expect(combineParts([{ quantity: 2, unit: "dl" }, { quantity: 1.5, unit: "dl" }])).toEqual({ quantity: "3.5", unit: "dl" });
    expect(combineParts([{ quantity: 1, unit: null }, { quantity: 2, unit: null }])).toEqual({ quantity: "3", unit: null });
  });

  it("keeps parts side by side when units differ or are missing", () => {
    expect(combineParts([{ quantity: 2, unit: "dl" }, { quantity: 1, unit: "msk" }, { quantity: 1, unit: null }])).toEqual({ quantity: "2 dl + 1 msk + 1", unit: null });
  });

  it("is null for no parts", () => {
    expect(combineParts([])).toEqual({ quantity: null, unit: null });
  });
});

describe("lineQuantity", () => {
  it("shows the Share total alone, the hand text alone, or both", () => {
    expect(lineQuantity([{ quantity: 400, unit: "g" }], null)).toEqual({ quantity: "400", unit: "g" });
    expect(lineQuantity([], "2 pack")).toEqual({ quantity: "2 pack", unit: null });
    expect(lineQuantity([{ quantity: 400, unit: "g" }], "2 pack")).toEqual({ quantity: "400 g + 2 pack", unit: null });
    expect(lineQuantity([], "  ")).toEqual({ quantity: null, unit: null });
  });
});

describe("needsMore", () => {
  it("is true when a line gains its first Share or its total grows", () => {
    expect(needsMore([], [{ quantity: 1, unit: null }])).toBe(true);
    expect(needsMore([{ quantity: 400, unit: "g" }], [{ quantity: 400, unit: "g" }, { quantity: 100, unit: "g" }])).toBe(true);
  });

  it("is false when a Swap replaces a Share with an equal or smaller one, or nothing is left", () => {
    expect(needsMore([{ quantity: 400, unit: "g" }], [{ quantity: 400, unit: "g" }])).toBe(false);
    expect(needsMore([{ quantity: 400, unit: "g" }], [{ quantity: 300, unit: "g" }])).toBe(false);
    expect(needsMore([{ quantity: 400, unit: "g" }], [])).toBe(false);
  });

  it("counts any addition as more when the totals cannot be compared", () => {
    expect(needsMore([{ quantity: 2, unit: "dl" }], [{ quantity: 2, unit: "dl" }, { quantity: 1, unit: "msk" }])).toBe(true);
  });
});
