import { describe, expect, it } from "vitest";
import { MAIN_CATEGORIES, MAIN_CATEGORY_KEYS, isMainCategory } from "./categories.js";

describe("Main Category list", () => {
  it("has exactly the 11 fixed keys, with 'other' last", () => {
    expect(MAIN_CATEGORY_KEYS).toEqual([
      "pasta",
      "rice",
      "potatoes",
      "fish",
      "chicken",
      "beef",
      "pork",
      "vegetarian",
      "soup",
      "tacos",
      "other",
    ]);
  });

  it("labels every category in both Swedish and English", () => {
    for (const key of MAIN_CATEGORY_KEYS) {
      expect(MAIN_CATEGORIES[key].en).not.toBe("");
      expect(MAIN_CATEGORIES[key].sv).not.toBe("");
    }
    expect(MAIN_CATEGORIES.tacos).toEqual({ en: "Tacos", sv: "Tacos" });
    expect(MAIN_CATEGORIES.potatoes).toEqual({ en: "Potatoes", sv: "Potatis" });
  });

  it("recognises only keys from the fixed list", () => {
    expect(isMainCategory("fish")).toBe(true);
    expect(isMainCategory("sushi")).toBe(false);
    expect(isMainCategory("")).toBe(false);
  });
});
