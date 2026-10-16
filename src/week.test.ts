import { describe, expect, it } from "vitest";
import { comingWeekStart, localDate, mondayOf, weekDates, weekdayDates, weekdayOf } from "./week.js";

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

describe("weekDates", () => {
  it("lists Monday to Sunday as ISO strings", () => {
    expect(weekDates("2026-10-12")).toEqual([
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
    expect(weekDates("2026-03-30")).toEqual([
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

describe("weekdayDates", () => {
  it("lists Monday to Friday", () => {
    expect(weekdayDates("2026-10-12")).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
  });
});

describe("weekdayOf", () => {
  it("maps an ISO date to its weekday key", () => {
    expect(weekdayOf("2026-10-18")).toBe("sun");
    expect(weekdayOf("2026-10-12")).toBe("mon");
  });
});

describe("localDate", () => {
  // 2026-10-11 23:30 UTC is already Monday 01:30 in Stockholm (CEST, UTC+2).
  const instant = new Date("2026-10-11T23:30:00Z");

  it("honours the timezone across midnight", () => {
    expect(localDate(instant, "Europe/Stockholm")).toBe("2026-10-12");
    expect(localDate(instant, "UTC")).toBe("2026-10-11");
    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-10-11");
  });

  it("uses the process time zone when none is given", () => {
    const d = new Date(2026, 9, 11, 23, 30);
    expect(localDate(d)).toBe("2026-10-11");
  });
});

describe("comingWeekStart", () => {
  it("is the Monday after the week containing now, in the given timezone", () => {
    const instant = new Date("2026-10-11T23:30:00Z"); // Sunday UTC, Monday in Stockholm
    expect(comingWeekStart(instant, "UTC")).toBe("2026-10-12");
    expect(comingWeekStart(instant, "Europe/Stockholm")).toBe("2026-10-19");
  });
});
