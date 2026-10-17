import { describe, expect, it } from "vitest";
import { isRedDay, swedishHoliday } from "./holidays.js";

describe("swedishHoliday", () => {
  it.each([
    // Easter-based: Långfredagen, Påskdagen, Annandag påsk, Kristi himmelsfärd, Pingstdagen.
    ["2024-03-29", "goodFriday"],
    ["2024-03-31", "easterSunday"],
    ["2024-04-01", "easterMonday"],
    ["2024-05-09", "ascension"],
    ["2024-05-19", "pentecost"],
    ["2025-04-18", "goodFriday"],
    ["2025-04-20", "easterSunday"],
    ["2025-04-21", "easterMonday"],
    ["2025-05-29", "ascension"],
    ["2025-06-08", "pentecost"],
    ["2026-04-03", "goodFriday"],
    ["2026-04-05", "easterSunday"],
    ["2026-04-06", "easterMonday"],
    ["2026-05-14", "ascension"],
    ["2026-05-24", "pentecost"],
    ["2027-03-26", "goodFriday"],
    ["2027-03-29", "easterMonday"],
    ["2038-04-25", "easterSunday"], // latest possible Easter in this century's range
    // Midsommarafton (Friday 19–25 June) and Midsommardagen (Saturday 20–26 June).
    ["2024-06-21", "midsummerEve"],
    ["2024-06-22", "midsummerDay"],
    ["2025-06-20", "midsummerEve"],
    ["2026-06-19", "midsummerEve"],
    ["2026-06-20", "midsummerDay"],
    ["2027-06-25", "midsummerEve"],
    // Alla helgons dag: Saturday 31 Oct–6 Nov.
    ["2024-11-02", "allSaints"],
    ["2025-11-01", "allSaints"],
    ["2026-10-31", "allSaints"],
    ["2027-11-06", "allSaints"],
    // Fixed dates.
    ["2026-01-01", "newYearsDay"],
    ["2026-01-06", "epiphany"],
    ["2026-05-01", "mayDay"],
    ["2026-06-06", "nationalDay"],
    ["2026-12-24", "christmasEve"],
    ["2026-12-25", "christmasDay"],
    ["2026-12-26", "boxingDay"],
    ["2026-12-31", "newYearsEve"],
  ])("%s is %s", (date, holiday) => {
    expect(swedishHoliday(date)).toBe(holiday);
  });

  it.each(["2026-06-26", "2026-11-07", "2026-04-04", "2026-10-21", "2025-06-27"])("%s is not a holiday", (date) => {
    expect(swedishHoliday(date)).toBeUndefined();
  });
});

describe("isRedDay", () => {
  it("is red on Sundays and public holidays, never on an ordinary Saturday", () => {
    expect(isRedDay("2026-10-18")).toBe(true); // Sunday
    expect(isRedDay("2026-10-17")).toBe(false); // ordinary Saturday stays ink
    expect(isRedDay("2026-10-31")).toBe(true); // Alla helgons dag, a Saturday
    expect(isRedDay("2026-05-14")).toBe(true); // Kristi himmelsfärdsdag, a Thursday
    expect(isRedDay("2026-10-21")).toBe(false); // ordinary Wednesday
  });
});
