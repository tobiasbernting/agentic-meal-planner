/**
 * Almanac markup (spec #71): the week landmark and the day-row frame. Presentation only; the
 * cell content comes from the caller (see src/almanac/day.ts for the lunch and Dinner cell
 * that Today and Plan share). Classes are defined in public/app.css.
 */
import { isRedDay, swedishHoliday } from "../calendar/holidays.js";
import { t, weekdayName, type Lang } from "../i18n/index.js";
import { addDays, isoWeek, weekdayOf } from "../week.js";
import { escapeHtml } from "./layout.js";

/**
 * How open a day row is. `full`: every detail (today on Today, every day on Plan). `half`:
 * lunch, Dinner, minutes (tomorrow on Today). `compact`: the lunch line and the Dinner name.
 */
export type DayDensity = "full" | "half" | "compact";

/** "v. 42" in large type with the month at the right, for the week holding `date`. */
export function weekHead(lang: Lang, date: string): string {
  const week = isoWeek(date);
  const month = new Intl.DateTimeFormat(lang === "sv" ? "sv-SE" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
  return `<header class="week-head"><h1 class="week-num" aria-label="${escapeHtml(t(lang, "week.label", { n: week }))}"><small>${escapeHtml(t(lang, "week.abbr"))}</small>${week}</h1><div class="week-month">${escapeHtml(month)}</div></header>`;
}

/**
 * Week navigation under the week landmark, "v. 41 ‹" and "› v. 43": links to `path?week=<monday>`
 * for the neighbouring ISO weeks. Plan and Shopping share it.
 */
export function weekNav(lang: Lang, weekStart: string, path: string): string {
  const prev = addDays(weekStart, -7);
  const next = addDays(weekStart, 7);
  const abbr = escapeHtml(t(lang, "week.abbr"));
  const name = (key: "week.prev" | "week.next", date: string) =>
    `${escapeHtml(t(lang, key))}, ${escapeHtml(t(lang, "week.label", { n: isoWeek(date) }))}`;
  return `<nav class="week-nav" aria-label="${escapeHtml(t(lang, "week.nav"))}">
<a href="${path}?week=${prev}" rel="prev" aria-label="${name("week.prev", prev)}">${abbr} ${isoWeek(prev)} <span aria-hidden="true">‹</span></a>
<a href="${path}?week=${next}" rel="next" aria-label="${name("week.next", next)}"><span aria-hidden="true">›</span> ${abbr} ${isoWeek(next)}</a>
</nav>`;
}

export interface DayRowOptions {
  lang: Lang;
  date: string;
  density: DayDensity;
  /** Marks the household's current date: raised background, heavy left rule, `aria-current="date"`. */
  today?: boolean;
  /** HTML inside the row's cell, right of the date column. Not escaped. */
  cellHtml: string;
}

/**
 * One almanac day row: `<article class="day day-<density>" id="day-<date>">` with the date
 * numeral and short weekday in the fixed left column. Sundays and Swedish holidays get
 * `day-red`; a holiday's name opens the cell. The weekday text is always present, so red is
 * never the only signal.
 */
export function dayRow({ lang, date, density, today = false, cellHtml }: DayRowOptions): string {
  const classes = ["day", `day-${density}`, today ? "day-today" : "", isRedDay(date) ? "day-red" : ""].filter(Boolean).join(" ");
  const holiday = swedishHoliday(date);
  const holidayLine = holiday ? `<div class="day-holiday">${escapeHtml(t(lang, `holiday.${holiday}`))}</div>` : "";
  const dayNum = Number(date.slice(8, 10));
  return `<article class="${classes}" id="day-${date}"${today ? ' aria-current="date"' : ""}>
<div class="day-date"><time datetime="${date}"><b>${dayNum}</b><span>${escapeHtml(weekdayName(lang, weekdayOf(date), "short"))}</span></time></div>
<div class="day-cell">${holidayLine}${cellHtml}</div>
</article>`;
}
