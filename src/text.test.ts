import { describe, expect, it } from "vitest";
import { normaliseName } from "./text.js";

describe("normaliseName", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normaliseName("  Whole \t  Milk ")).toBe("whole milk");
  });
});
