import { describe, expect, it } from "vitest";
import { storeSectionOf } from "./store-sections.js";

describe("storeSectionOf", () => {
  it.each([
    ["nötfärs", "meat"],
    ["laxfilé", "meat"],
    ["Falukorv", "meat"],
    ["isbergssallad", "produce"],
    ["gul lök", "produce"],
    ["bananer", "produce"],
    ["hamburgerbröd", "bread"],
    ["gräddfil", "dairy"],
    ["matlagningsgrädde", "dairy"],
    ["crème fraiche", "dairy"],
    ["riven ost", "dairy"],
    ["ägg", "dairy"],
    ["vetemjöl", "dry"],
    ["mjölk", "dairy"],
    ["kokosmjölk", "dry"],
    ["olivolja", "dry"],
    ["tomatpuré", "dry"],
    ["krossade tomater", "dry"],
    ["tacoskal", "dry"],
    ["frysta ärtor", "frozen"],
    ["blöjor", "household"],
    ["ice cream", "frozen"],
    ["chicken thighs", "meat"],
    ["sour cream", "dairy"],
    ["candles", "other"],
    ["", "other"],
  ])("%s is %s", (name, section) => {
    expect(storeSectionOf(name)).toBe(section);
  });

  it("never matches a short word inside a longer one", () => {
    expect(storeSectionOf("rostbiff")).toBe("meat");
    expect(storeSectionOf("te")).toBe("dry");
    expect(storeSectionOf("paté")).toBe("other");
  });
});
