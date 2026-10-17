/**
 * The almanac day (spec #71) that Today and Plan share: a day row whose cell holds the lunch
 * on the name-day line and the Planned Dinner as the main text, at a chosen density. Build
 * one `almanac(db, lang)` per page render (it loads the no-lunch notice, planner settings and
 * each week's plan once), then call `day()` per date.
 */
import type Database from "better-sqlite3";
import { swedishHoliday } from "../calendar/holidays.js";
import { getDish, type Dish } from "../dishes/repo.js";
import { isWeekend } from "../engine/filter.js";
import { suggestedBadge } from "../dishes/suggested-badge.js";
import { t, type Lang } from "../i18n/index.js";
import { noLunchNotice } from "../lunch/notice.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { getPlanForWeek, type PlannedDinner, type WeeklyPlan } from "../planner/repo.js";
import { quickDayLimitFor, readPlannerSettings } from "../planner/settings.js";
import { dayRow, type DayDensity } from "../ui/almanac.js";
import { escapeHtml } from "../ui/layout.js";
import { mondayOf, weekdayOf } from "../week.js";

export interface AlmanacDayOptions {
  date: string;
  density: DayDensity;
  today?: boolean;
  /** Shown in a `full` row when the date's week has no Weekly Plan. Default: "No plan". */
  noPlanHtml?: string;
  /** The swap control in a `full` row (`swapControl`); nothing when absent. */
  swapHtml?: string;
  /** Extra HTML at the end of the cell (a degraded reason, say). Not escaped. */
  extraHtml?: string;
}

const lines = (rawText: string) =>
  rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export function almanac(db: Database.Database, lang: Lang) {
  const notice = noLunchNotice(db);
  const settings = readPlannerSettings(db);
  const plans = new Map<string, WeeklyPlan | undefined>();
  const planFor = (date: string) => {
    const weekStart = mondayOf(date);
    if (!plans.has(weekStart)) plans.set(weekStart, getPlanForWeek(db, weekStart));
    return plans.get(weekStart);
  };

  /** No School serves lunch on a weekend or a holiday: say so instead of "no lunch data". */
  const noSchoolDay = (date: string) => isWeekend(weekdayOf(date)) || swedishHoliday(date) !== undefined;

  function lunchHtml(date: string, density: DayDensity): string {
    const lunches = listLunchForDate(db, date);
    if (lunches.length === 0) return "";
    const served = lunches.filter((l): l is SchoolLunch & { entry: NonNullable<SchoolLunch["entry"]> } => l.entry !== null);
    if (served.length === 0 && noSchoolDay(date)) return `<div class="day-lunch">${t(lang, "day.noSchoolLunch")}</div>`;
    if (density === "full") {
      return lunches
        .map(({ school, entry }) => {
          const label = `<div class="label">${t(lang, "day.lunchAt", { school: escapeHtml(school.name) })}</div>`;
          const body = entry
            ? `<ul class="day-lunch">${lines(entry.rawText)
                .map((line) => `<li>${escapeHtml(line)}</li>`)
                .join("")}</ul>`
            : notice(lang, date, school);
          return label + body;
        })
        .join("");
    }
    if (served.length === 0) return `<div class="day-lunch">${t(lang, "common.noLunchData")}</div>`;
    const text = served
      .map(({ school, entry }) => (lunches.length > 1 ? `${school.name}: ` : "") + lines(entry.rawText).join(" · "))
      .join(" / ");
    return `<div class="day-lunch">${escapeHtml(text)}</div>`;
  }

  function metaHtml(date: string, dinner: PlannedDinner, dish: Dish): string {
    const parts: string[] = [];
    if (dinner.isQuickDay) {
      const limit = quickDayLimitFor(settings, mondayOf(date), weekdayOf(date));
      parts.push(`<span class="tag">${limit === null ? t(lang, "plan.quickDay") : t(lang, "day.quickDayMax", { n: limit })}</span>`);
    }
    if (dish.prepTimeMinutes !== null) parts.push(`<span>${t(lang, "dishes.prepMinutes", { n: dish.prepTimeMinutes })}</span>`);
    return parts.length ? `<div class="meta">${parts.join("")}</div>` : "";
  }

  function dinnerHtml(opts: AlmanacDayOptions): string {
    const { date, density } = opts;
    const label = density === "full" ? `<div class="label">${t(lang, "common.dinner")}</div>` : "";
    const plan = planFor(date);
    if (!plan) {
      if (density === "full" && opts.noPlanHtml) return label + opts.noPlanHtml;
      return `${label}<div class="day-dinner muted">${t(lang, "day.noPlan")}</div>`;
    }
    const dinner = plan.dinners.find((d) => d.date === date);
    if (!dinner) return `${label}<div class="day-dinner muted">${t(lang, "plan.noDinner")}</div>`;
    const dish = dinner.dishId === null ? undefined : getDish(db, dinner.dishId);
    if (!dish) {
      const pick = density === "full" && opts.swapHtml ? `<div class="actions">${opts.swapHtml}</div>` : "";
      return `${label}<div class="day-dinner">${t(lang, "common.noEligibleDish")}</div>${pick}`;
    }
    const name = `<div class="day-dinner">${escapeHtml(dish.name)}</div>`;
    if (density === "compact") return name;
    if (density === "half") return name + metaHtml(date, dinner, dish);
    const why = dinner.rationale.trim() ? `<p class="why">${escapeHtml(dinner.rationale)}</p>` : "";
    const recipe = dish.recipeUrl ?? dinner.sourceUrl;
    const swap = opts.swapHtml ?? "";
    const recipeLink = recipe ? `<a class="button" href="${escapeHtml(recipe)}">${t(lang, "day.recipe")}</a>` : "";
    const suggested = dish.suggested ? `<div class="suggested">${suggestedBadge(lang, dish)}</div>` : "";
    return `${label}${name}${metaHtml(date, dinner, dish)}${suggested}${why}<div class="actions">${swap}${recipeLink}</div>`;
  }

  return {
    /** One almanac day row for `opts.date`. */
    day(opts: AlmanacDayOptions): string {
      const cellHtml = lunchHtml(opts.date, opts.density) + dinnerHtml(opts) + (opts.extraHtml ?? "");
      return dayRow({ lang, date: opts.date, density: opts.density, today: opts.today, cellHtml });
    },
  };
}
