/**
 * Swedish red days (spec #71, the almanac): Sundays plus the public holidays, computed
 * locally with no network call. Besides the statutory holidays the list includes the three
 * "aftnar" (Midsommarafton, Julafton, Nyårsafton), which the law treats like Sundays and
 * which households read as red. Dates are ISO `YYYY-MM-DD`; arithmetic is UTC.
 */
import { addDays, weekdayOf } from "../week.js";

export const HOLIDAYS = [
  "newYearsDay",
  "epiphany",
  "goodFriday",
  "easterSunday",
  "easterMonday",
  "mayDay",
  "ascension",
  "pentecost",
  "nationalDay",
  "midsummerEve",
  "midsummerDay",
  "allSaints",
  "christmasEve",
  "christmasDay",
  "boxingDay",
  "newYearsEve",
] as const;
export type Holiday = (typeof HOLIDAYS)[number];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** Easter Sunday (Gregorian), by the anonymous Meeus/Jones/Butcher algorithm. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** The first date from `from` (inclusive) that falls on `weekday`. */
function firstOnOrAfter(from: string, weekday: "fri" | "sat"): string {
  let date = from;
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

const cache = new Map<number, Map<string, Holiday>>();

/** Every Swedish holiday of `year`, keyed by date. */
export function swedishHolidays(year: number): Map<string, Holiday> {
  const cached = cache.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const midsummerEve = firstOnOrAfter(iso(year, 6, 19), "fri");
  const days = new Map<string, Holiday>([
    [iso(year, 1, 1), "newYearsDay"],
    [iso(year, 1, 6), "epiphany"],
    [addDays(easter, -2), "goodFriday"],
    [easter, "easterSunday"],
    [addDays(easter, 1), "easterMonday"],
    [iso(year, 5, 1), "mayDay"],
    [addDays(easter, 39), "ascension"],
    [addDays(easter, 49), "pentecost"],
    [iso(year, 6, 6), "nationalDay"],
    [midsummerEve, "midsummerEve"],
    [addDays(midsummerEve, 1), "midsummerDay"],
    [firstOnOrAfter(iso(year, 10, 31), "sat"), "allSaints"],
    [iso(year, 12, 24), "christmasEve"],
    [iso(year, 12, 25), "christmasDay"],
    [iso(year, 12, 26), "boxingDay"],
    [iso(year, 12, 31), "newYearsEve"],
  ]);
  cache.set(year, days);
  return days;
}

/** The holiday on `date`, or undefined for an ordinary day. */
export function swedishHoliday(date: string): Holiday | undefined {
  return swedishHolidays(Number(date.slice(0, 4))).get(date);
}

/** Red in the almanac: a Sunday or a holiday. An ordinary Saturday stays ink. */
export function isRedDay(date: string): boolean {
  return weekdayOf(date) === "sun" || swedishHoliday(date) !== undefined;
}
