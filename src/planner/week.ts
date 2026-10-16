/**
 * Week arithmetic for the Weekly Plan (Monday–Sunday, FR-9). All dates are ISO
 * `YYYY-MM-DD` strings and the math is done in UTC so no local timezone can shift a day.
 */
import { weekdayOf } from "../engine/filter.js";
import { WEEKDAYS } from "../dishes/repo.js";

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week containing `date` (a Monday maps to itself). */
export function mondayOf(date: string): string {
  const offset = WEEKDAYS.indexOf(weekdayOf(date));
  return addDays(date, -offset);
}

/** The seven dates of the week starting at `weekStart` (a Monday), in order. */
export function datesOfWeek(weekStart: string): string[] {
  return WEEKDAYS.map((_, i) => addDays(weekStart, i));
}
