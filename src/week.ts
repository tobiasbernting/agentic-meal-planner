/**
 * Date helpers for the Monday-start week (FR-9). Dates are ISO `YYYY-MM-DD` strings and the
 * arithmetic is UTC so no local time zone can shift a day. `localDate` is the one place a
 * clock `Date` becomes a household calendar date.
 */
import { WEEKDAYS, type Weekday } from "./dishes/repo.js";

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The seven dates Monday..Sunday starting at `weekStart`. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** The five dates Monday..Friday starting at `weekStart`: the days a School serves lunch. */
export function weekdayDates(weekStart: string): string[] {
  return weekDates(weekStart).slice(0, 5);
}

/** Weekday key of an ISO `YYYY-MM-DD` date, UTC-safe (no local-timezone drift). */
export function weekdayOf(date: string): Weekday {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(index + 6) % 7]!;
}

/** The Monday of the week containing `date` (a Monday maps to itself). */
export function mondayOf(date: string): string {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

/**
 * Calendar date `YYYY-MM-DD` of `d` in IANA `timezone`; without one, the process time zone
 * (the household's clock, not UTC).
 */
export function localDate(d: Date, timezone?: string): string {
  if (timezone) return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The Monday of the week after the one containing `now` (the week the Sunday run plans). */
export function comingWeekStart(now: Date, timezone?: string): string {
  return addDays(mondayOf(localDate(now, timezone)), 7);
}
