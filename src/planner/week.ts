/**
 * Week arithmetic for the Weekly Plan (Monday–Sunday, FR-9). All dates are ISO
 * `YYYY-MM-DD` strings and the math is done in UTC so no local timezone can shift a day.
 * Day arithmetic itself lives in `src/lunch/week.ts`; this module adds the planner's view.
 */
import { weekdayOf } from "../engine/filter.js";
import { WEEKDAYS } from "../dishes/repo.js";
import { addDays, weekDates } from "../lunch/week.js";

/** The Monday of the week containing `date` (a Monday maps to itself). */
export function mondayOf(date: string): string {
  const offset = WEEKDAYS.indexOf(weekdayOf(date));
  return addDays(date, -offset);
}

/** The seven dates of the week starting at `weekStart` (a Monday), in order. */
export function datesOfWeek(weekStart: string): string[] {
  return weekDates(weekStart);
}
