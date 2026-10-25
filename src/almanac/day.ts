/**
 * The almanac day (spec #71) that Today and Plan share: a day row whose cell holds the lunch
 * on the name-day line and the Planned Dinner as the main text, at a chosen density. Build
 * one `almanac(db, lang)` per page render (it loads the no-lunch notice, planner settings and
 * each week's plan once), then call `day()` per date. With `todos` set, each cell also carries
 * the Todos due that date after the Dinner (ADR-0010), loaded once per week like the plans.
 */
import type Database from "better-sqlite3";
import { swedishHoliday } from "../calendar/holidays.js";
import { getDish, type Dish } from "../dishes/repo.js";
import { isWeekend } from "../engine/filter.js";
import { suggestedBadge } from "../dishes/suggested-badge.js";
import { LANGS, t, type Lang, type MessageKey } from "../i18n/index.js";
import { noLunchNotice } from "../lunch/notice.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { getList, type List } from "../lists/repo.js";
import { listOverdueTodos, listTodosDueBetween, type Todo } from "../lists/todos.js";
import { listName, todoRow } from "../lists/view.js";
import { listMembers, type Member } from "../members/repo.js";
import { getPlanForWeek, type PlannedDinner, type WeeklyPlan } from "../planner/repo.js";
import { quickDayLimitFor, readPlannerSettings } from "../planner/settings.js";
import { dayRow, type DayDensity } from "../ui/almanac.js";
import { escapeHtml } from "../ui/layout.js";
import { addDays, mondayOf, weekdayOf } from "../week.js";

/** Rationales the planner writes itself when it falls back; a degraded notice already says the same. */
const GENERIC_RATIONALE_KEYS: MessageKey[] = ["rationale.seedFallback", "rationale.pickDropped"];

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
  /** The day carries a degraded notice, so the generic fallback rationales would repeat it. */
  hideGenericRationale?: boolean;
  /** List overdue Todos first, under "Försenat" (today's row on Today). */
  overdueTodos?: boolean;
  /** No Todos on this row (a past day on Today, whose open Todos show as overdue on today's). */
  hideTodos?: boolean;
}

/** Todos on the almanac: the household's date, where a tick returns, and the Mina filter. */
export interface AlmanacTodoOptions {
  today: string;
  timezone: string | undefined;
  /** The page a tick returns to without HTMX. */
  next: string;
  /** Only Todos assigned to this Member (the Mina toggle). */
  mineId?: number;
}

/** A `half` row lists this many Todos, then "+N till". */
const HALF_TODOS = 3;

const lines = (rawText: string) =>
  rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export function almanac(db: Database.Database, lang: Lang, todos?: AlmanacTodoOptions) {
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
    const generic = opts.hideGenericRationale && GENERIC_RATIONALE_KEYS.some((k) => LANGS.some((l) => t(l, k) === dinner.rationale.trim()));
    const why = dinner.rationale.trim() && !generic ? `<p class="why">${escapeHtml(dinner.rationale)}</p>` : "";
    const recipe = dish.recipeUrl ?? dinner.sourceUrl;
    const swap = opts.swapHtml ?? "";
    const recipeLink = recipe ? `<a class="button" href="${escapeHtml(recipe)}">${t(lang, "day.recipe")}</a>` : "";
    const suggested = dish.suggested ? `<div class="suggested">${suggestedBadge(lang, dish)}</div>` : "";
    return `${label}${name}${metaHtml(date, dinner, dish)}${suggested}${why}<div class="actions">${swap}${recipeLink}</div>`;
  }

  const weekTodos = new Map<string, Todo[]>();
  const lists = new Map<number, List | undefined>();
  let members: Member[] | undefined;
  const mine = (list: Todo[]) => (todos?.mineId === undefined ? list : list.filter((todo) => todo.memberId === todos.mineId));
  const dueOn = (date: string) => {
    const weekStart = mondayOf(date);
    if (!weekTodos.has(weekStart)) weekTodos.set(weekStart, listTodosDueBetween(db, weekStart, addDays(weekStart, 6)));
    return mine(weekTodos.get(weekStart)!.filter((todo) => todo.dueDate === date));
  };
  const listNameOf = (id: number) => {
    if (!lists.has(id)) lists.set(id, getList(db, id));
    const list = lists.get(id);
    return list ? listName(lang, list) : undefined;
  };

  function todoRows(opts: AlmanacTodoOptions, list: Todo[]): string {
    members ??= listMembers(db);
    const rows = list.map((todo) => {
      const name = listNameOf(todo.listId);
      return todoRow(lang, todo, members!, { today: opts.today, timezone: opts.timezone, next: opts.next, ...(name ? { listName: name } : {}) });
    });
    return `<ul class="rows day-todos">\n${rows.join("\n")}\n</ul>`;
  }

  /** The Todos due on `date` at the row's density; overdue ones first when asked. Empty when none. */
  function todosHtml(date: string, density: DayDensity, overdue = false): string {
    if (!todos) return "";
    const due = dueOn(date);
    const late = overdue ? mine(listOverdueTodos(db, date)) : [];
    if (due.length === 0 && late.length === 0) return "";
    if (density === "compact") {
      const n = due.length + late.length;
      return `<div class="day-todos-count">${escapeHtml(t(lang, n === 1 ? "day.todos.one" : "day.todos.other", { n }))}</div>`;
    }
    if (density === "half") {
      const all = [...late, ...due];
      const more = all.length - HALF_TODOS;
      return todoRows(todos, all.slice(0, HALF_TODOS)) + (more > 0 ? `<div class="day-todos-more muted">${escapeHtml(t(lang, "day.todos.more", { n: more }))}</div>` : "");
    }
    const lateHtml = late.length ? `<div class="label">${t(lang, "day.overdue")}</div>${todoRows(todos, late)}` : "";
    const dueHtml = due.length ? `<div class="label">${t(lang, "day.todos")}</div>${todoRows(todos, due)}` : "";
    return lateHtml + dueHtml;
  }

  return {
    /** One almanac day row for `opts.date`. */
    day(opts: AlmanacDayOptions): string {
      const cellHtml = lunchHtml(opts.date, opts.density) + dinnerHtml(opts) + (opts.hideTodos ? "" : todosHtml(opts.date, opts.density, opts.overdueTodos)) + (opts.extraHtml ?? "");
      return dayRow({ lang, date: opts.date, density: opts.density, today: opts.today, cellHtml });
    },
  };
}
