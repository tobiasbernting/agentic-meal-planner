/**
 * The Daily Brief (ADR-0010): one message a day with today's lunch per School, today's Dinner,
 * the Todos due today and overdue (with their Member), and how many Shopping List lines are left
 * to buy. Composed from the same data the almanac reads, in the household's notice language.
 * Empty sections are left out; a day with nothing to say has no brief.
 */
import type Database from "better-sqlite3";
import { getDish } from "../dishes/repo.js";
import { t, type Lang } from "../i18n/index.js";
import { listOverdueTodos, listTodosDue, type Todo } from "../lists/todos.js";
import { listLunchForDate } from "../lunch/repo.js";
import { getPlanForWeek } from "../planner/repo.js";
import { getShoppingList } from "../shopping/list.js";
import { shortDate } from "../shopping/view.js";
import { mondayOf } from "../week.js";

export interface Notice {
  title: string;
  text: string;
}

function todoLine(lang: Lang, todo: Todo, overdue: boolean): string {
  const parts = [todo.title];
  if (todo.dueTime) parts.push(todo.dueTime);
  const extra = [overdue ? t(lang, "todo.overdue").toLowerCase() : "", todo.memberName ?? ""].filter(Boolean).join(", ");
  return `- ${parts.join(" ")}${extra ? ` (${extra})` : ""}`;
}

export function dailyBrief(db: Database.Database, lang: Lang, today: string): Notice | undefined {
  const sections: string[] = [];

  const lunches = listLunchForDate(db, today).flatMap(({ school, entry }) => {
    const menu = entry?.rawText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" · ");
    return menu ? [`${t(lang, "day.lunchAt", { school: school.name })}: ${menu}`] : [];
  });
  if (lunches.length) sections.push(lunches.join("\n"));

  const dinner = getPlanForWeek(db, mondayOf(today))?.dinners.find((d) => d.date === today);
  const dish = dinner?.dishId == null ? undefined : getDish(db, dinner.dishId);
  if (dish) sections.push(`${t(lang, "common.dinner")}: ${dish.name}`);

  const todos = [...listOverdueTodos(db, today).map((todo) => todoLine(lang, todo, true)), ...listTodosDue(db, today).map((todo) => todoLine(lang, todo, false))];
  if (todos.length) sections.push(`${t(lang, "day.todos")}:\n${todos.join("\n")}`);

  const toBuy = getShoppingList(db).buy.filter((line) => !line.checked).length;
  if (toBuy > 0) sections.push(t(lang, toBuy === 1 ? "brief.toBuy.one" : "brief.toBuy.other", { n: toBuy }));

  if (sections.length === 0) return undefined;
  return { title: t(lang, "brief.title", { date: shortDate(lang, today) }), text: sections.join("\n\n") };
}
