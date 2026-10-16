import { describe, expect, it } from "vitest";
import { datesOfWeek, mondayOf } from "./week.js";

describe("mondayOf", () => {
  it.each([
    ["2026-10-16", "2026-10-12"], // Friday
    ["2026-10-12", "2026-10-12"], // Monday itself
    ["2026-10-18", "2026-10-12"], // Sunday belongs to the week that started the Monday before
    ["2026-01-01", "2025-12-29"], // crosses a year boundary
  ])("%s -> %s", (date, expected) => {
    expect(mondayOf(date)).toBe(expected);
  });
});

describe("datesOfWeek", () => {
  it("lists Monday to Sunday as ISO strings", () => {
    expect(datesOfWeek("2026-10-12")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
  });

  it("crosses a month boundary without timezone drift", () => {
    expect(datesOfWeek("2026-03-30")).toEqual([
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04",
      "2026-04-05",
    ]);
  });
});
