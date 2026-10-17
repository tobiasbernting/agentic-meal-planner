import { describe, expect, it } from "vitest";
import { isMainCategory } from "../dishes/categories.js";
import { DEFAULT_SUGGESTION_STYLE, SEED_DISHES } from "./seed-dishes.js";

describe("SEED_DISHES", () => {
  it("holds about twenty entries with valid categories, positive integer prep times and unique names", () => {
    expect(SEED_DISHES.length).toBeGreaterThanOrEqual(18);
    expect(SEED_DISHES.length).toBeLessThanOrEqual(24);
    for (const d of SEED_DISHES) {
      expect(d.name.trim()).not.toBe("");
      expect(isMainCategory(d.mainCategory)).toBe(true);
      expect(Number.isInteger(d.prepTimeMinutes) && d.prepTimeMinutes > 0).toBe(true);
    }
    expect(new Set(SEED_DISHES.map((d) => d.name.toLowerCase())).size).toBe(SEED_DISHES.length);
  });

  it("has a default suggestion style", () => {
    expect(DEFAULT_SUGGESTION_STYLE).toBe("family-friendly Swedish home cooking for a household with kids");
  });
});
