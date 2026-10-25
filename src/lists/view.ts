/**
 * The Lists pages' parts (ADR-0010): the Listor index, a todo-style List page with its Todo rows
 * and add form, the Todo edit page, and the confirmation pages for Clear and Delete.
 * Shopping-style Lists reuse the Shopping page's line parts (src/shopping/view.ts).
 */
import type { AppContext } from "../app.js";
import { WEEKDAYS } from "../dishes/repo.js";
import { t, weekdayName, type Lang, type MessageKey } from "../i18n/index.js";
import { memberChip } from "../members/device.js";
import { listMembers, type Member } from "../members/repo.js";
import { readTimezone } from "../planner/settings.js";
import { shortDate } from "../shopping/view.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { shortWhen } from "../ui/when.js";
import { SHOPPING_LIST_ID } from "./schema.js";
import { countOpenItems, type List } from "./repo.js";
import { describeRepeat, REPEAT_KINDS, type RepeatRule } from "./repeat.js";
import type { ActivityRow } from "./activity.js";
import type { QuickAddSpan } from "./quick-add.js";
import { addDays, localDate, localTime } from "../week.js";
import type { DoneRecord, Todo } from "./todos.js";

/** The List's name as shown: the Shopping List takes the UI language's name. */
export function listName(lang: Lang, list: List): string {
  return list.id === SHOPPING_LIST_ID ? t(lang, "shopping.title") : list.name;
}

export function listHref(list: Pick<List, "id">): string {
  return list.id === SHOPPING_LIST_ID ? "/shopping" : `/lists/${list.id}`;
}

function openCount(lang: Lang, n: number): string {
  return t(lang, n === 1 ? "count.open.one" : "count.open.other", { n });
}

/** Listor: every List as a row with its kind and open count, the Shopping List first. */
export function listsPage(lang: Lang, ctx: AppContext, lists: List[], error?: string): string {
  const rows = lists
    .map((list) => {
      const kind = t(lang, list.kind === "shopping" ? "lists.shoppingKind" : "lists.todoKind");
      return `<li><a class="row-link" href="${listHref(list)}"><span class="row-label">${escapeHtml(listName(lang, list))}</span><span class="row-status">${escapeHtml(kind)} · ${escapeHtml(openCount(lang, countOpenItems(ctx.db, list.id)))}</span></a></li>`;
    })
    .join("\n");
  const body = `<header class="page-head"><h1>${t(lang, "lists.title")}</h1></header>
${error ? notice({ text: error }) : ""}
<ul class="rows">
${rows}
</ul>
<form method="post" action="/lists" class="lists-add">
  <h2>${t(lang, "lists.new")}</h2>
  <label>${t(lang, "lists.name")} <input name="name" required /></label>
  <fieldset>
    <legend>${t(lang, "lists.kind")}</legend>
    <label><input type="radio" name="kind" value="todo" checked /> ${t(lang, "lists.kind.todo")}</label>
    <label><input type="radio" name="kind" value="shopping" /> ${t(lang, "lists.kind.shopping")}</label>
  </fieldset>
  <div class="actions"><button type="submit">${t(lang, "lists.create")}</button></div>
</form>`;
  return page({ title: t(lang, "lists.title"), body, lang, tab: "lists" });
}

/** The page head of a List: its name and the edit link. */
export function listHead(lang: Lang, list: List): string {
  return `<header class="page-head"><h1>${escapeHtml(listName(lang, list))}</h1><a class="button quiet" href="/lists/${list.id}/edit">${t(lang, "lists.edit")}</a></header>`;
}

export function listEditPage(lang: Lang, list: List, lists: List[], error?: string): string {
  const others = lists.filter((l) => l.id !== SHOPPING_LIST_ID);
  const index = others.findIndex((l) => l.id === list.id);
  const move = (direction: "up" | "down", label: string, disabled: boolean) =>
    `<form method="post" action="/lists/${list.id}/move"><input type="hidden" name="direction" value="${direction}" /><button type="submit" class="quiet"${disabled ? " disabled" : ""}>${label}</button></form>`;
  const body = `<header class="page-head"><h1>${t(lang, "lists.edit")}</h1></header>
${error ? notice({ text: error }) : ""}
<form method="post" action="/lists/${list.id}">
  <label>${t(lang, "lists.name")} <input name="name" required value="${escapeHtml(list.name)}" /></label>
  <button type="submit">${t(lang, "common.save")}</button>
</form>
<div class="actions">${move("up", t(lang, "lists.moveUp"), index <= 0)}${move("down", t(lang, "lists.moveDown"), index === -1 || index >= others.length - 1)}<a class="button quiet" href="/lists/${list.id}/delete">${t(lang, "common.delete")}</a></div>
<p><a href="${listHref(list)}">${escapeHtml(listName(lang, list))}</a> · <a href="/lists">${t(lang, "lists.back")}</a></p>`;
  return page({ title: t(lang, "lists.edit"), body, lang, tab: "lists" });
}

export function listDeletePage(lang: Lang, ctx: AppContext, list: List): string {
  const open = openCount(lang, countOpenItems(ctx.db, list.id));
  const body = `<header class="page-head"><h1>${t(lang, "lists.deleteTitle")}</h1></header>
<p>${escapeHtml(t(lang, "lists.deleteText", { name: list.name, open }))}</p>
<form method="post" action="/lists/${list.id}/delete">
  <button type="submit" class="primary">${escapeHtml(t(lang, "lists.deleteConfirm", { name: list.name }))}</button>
</form>
<p><a href="${listHref(list)}">${t(lang, "lists.deleteCancel")}</a></p>`;
  return page({ title: t(lang, "lists.deleteTitle"), body, lang, tab: "lists" });
}

export function listClearPage(lang: Lang, list: List, n: number): string {
  const body = `<header class="page-head"><h1>${t(lang, "lists.clearTitle")}</h1></header>
<p>${escapeHtml(t(lang, "lists.clearText", { n, name: listName(lang, list) }))}</p>
<form method="post" action="/lists/${list.id}/clear">
  <button type="submit" class="primary">${escapeHtml(t(lang, "lists.clearConfirm", { n }))}</button>
</form>
<p><a href="${listHref(list)}">${t(lang, "shopping.clearCancel")}</a></p>`;
  return page({ title: t(lang, "lists.clearTitle"), body, lang, tab: "lists" });
}

/** "Rensa klara (N)" leading to the List's confirmation page; nothing when no item is done. */
export function listClearControl(lang: Lang, list: List, n: number): string {
  if (n === 0) return "";
  return `<p class="clear-control"><a class="button quiet" href="/lists/${list.id}/clear">${escapeHtml(t(lang, "lists.clear", { n }))}</a></p>`;
}

export interface TodoRowOptions {
  /** The household's current date, for the overdue mark. */
  today: string;
  timezone: string | undefined;
  /** Where the tick returns without HTMX; the List page by default. */
  next?: string;
  /** Show the List's name on the row (Today and Plan). */
  listName?: string;
  /** Short status to show for a moment after a repeating Todo advanced. */
  flash?: string;
  /** The phrase this Todo was just Quick Added from, with its parsed spans to mark once. */
  quickAdd?: QuickAddEcho;
}

export interface QuickAddEcho {
  text: string;
  spans: QuickAddSpan[];
}

/**
 * The typed phrase with the parsed words as `<mark>`, and "behåll som text", which re-posts the
 * phrase with `raw=1` to save it whole as the title of this same Todo. Nothing when nothing parsed.
 */
function quickAddEcho(lang: Lang, todo: Todo, echo: QuickAddEcho): string {
  if (echo.spans.length === 0) return "";
  let html = "";
  let at = 0;
  for (const span of echo.spans) {
    html += `${escapeHtml(echo.text.slice(at, span.start))}<mark>${escapeHtml(echo.text.slice(span.start, span.end))}</mark>`;
    at = span.end;
  }
  html += escapeHtml(echo.text.slice(at));
  return `\n<div class="quick-add-echo" role="status"><span class="quick-add-text">${html}</span><form method="post" action="/lists/${todo.listId}/todos">
  <input type="hidden" name="text" value="${escapeHtml(echo.text)}" />
  <input type="hidden" name="raw" value="1" />
  <input type="hidden" name="replace" value="${todo.id}" />
  <button type="submit" class="quiet">${t(lang, "quickAdd.keepText")}</button>
</form></div>`;
}

/** "fre 31 okt 15:00" or "fre 31 okt". */
export function dueText(lang: Lang, todo: Pick<Todo, "dueDate" | "dueTime">): string {
  if (!todo.dueDate) return "";
  return todo.dueTime ? `${shortDate(lang, todo.dueDate)} ${todo.dueTime}` : shortDate(lang, todo.dueDate);
}

function tickForm(lang: Lang, todo: Todo, next: string | undefined): string {
  const action = todo.doneAt ? `/todos/${todo.id}/untick` : `/todos/${todo.id}/tick`;
  const key = todo.doneAt ? "todo.untick" : "todo.tick";
  const hidden = next ? `\n  <input type="hidden" name="next" value="${escapeHtml(next)}" />` : "";
  return `<form method="post" action="${action}" hx-post="${action}" hx-target="closest li" hx-swap="outerHTML">${hidden}
  <button type="submit" class="tick" aria-label="${escapeHtml(t(lang, key, { title: todo.title }))}" aria-pressed="${todo.doneAt !== null}"></button>
</form>`;
}

/** One Todo as a ruled row: tick, title, then due, Member, repeat and done attribution. */
export function todoRow(lang: Lang, todo: Todo, members: Member[], opts: TodoRowOptions): string {
  const overdue = todo.doneAt === null && todo.dueDate !== null && todo.dueDate < opts.today;
  const classes = ["row", "todo", todo.doneAt ? "todo-done" : "", overdue ? "todo-overdue" : ""].filter(Boolean).join(" ");
  const label = todo.doneAt ? `<s class="row-label">${escapeHtml(todo.title)}</s>` : `<span class="row-label">${escapeHtml(todo.title)}</span>`;
  const meta: string[] = [];
  if (opts.flash) meta.push(`<span class="todo-flash" role="status">${escapeHtml(opts.flash)}</span>`);
  if (overdue) meta.push(`<span class="todo-overdue-mark">${t(lang, "todo.overdue")}</span>`);
  if (todo.dueDate) meta.push(`<span class="todo-due">${escapeHtml(dueText(lang, todo))}</span>`);
  if (todo.memberId !== null || todo.memberName) {
    const member = members.find((m) => m.id === todo.memberId);
    meta.push(member ? memberChip(member) : `<span class="member-chip">${escapeHtml(todo.memberName ?? "")}</span>`);
  }
  if (todo.repeat) meta.push(`<span class="todo-repeat">↻ ${escapeHtml(describeRepeat(todo.repeat, lang))}</span>`);
  if (opts.listName) meta.push(`<span class="todo-list">${escapeHtml(opts.listName)}</span>`);
  if (todo.doneAt) meta.push(`<span class="todo-done-by">${escapeHtml(todo.doneBy ? t(lang, "todo.doneBy", { name: todo.doneBy, time: shortWhen(lang, todo.doneAt, opts.timezone) }) : t(lang, "todo.doneAt", { time: shortWhen(lang, todo.doneAt, opts.timezone) }))}</span>`);
  const metaHtml = (meta.length ? `\n<div class="todo-meta">${meta.join("")}</div>` : "") + (opts.quickAdd ? quickAddEcho(lang, todo, opts.quickAdd) : "");
  const end = `\n<div class="todo-end"><a class="button quiet" href="/todos/${todo.id}/edit">${t(lang, "todo.edit")}</a></div>`;
  return `<li class="${classes}" data-todo="${todo.id}">${tickForm(lang, todo, opts.next)}<div class="todo-body">${label}${metaHtml}</div>${end}</li>`;
}

function memberSelect(lang: Lang, members: Member[], chosen: number | null, name = "member"): string {
  const options = [`<option value=""${chosen === null ? " selected" : ""}>${t(lang, "todo.memberNone")}</option>`, ...members.map((m) => `<option value="${m.id}"${m.id === chosen ? " selected" : ""}>${escapeHtml(m.name)}</option>`)];
  return `<label>${t(lang, "todo.member")} <select name="${name}">${options.join("")}</select></label>`;
}

/** Quick Add at the top of a todo-style List: one phrase; Due, Repeat and Member come from its words. */
export function todoAddForm(lang: Lang, list: List): string {
  return `<form method="post" action="/lists/${list.id}/todos" class="todo-add">
  <label>${t(lang, "quickAdd.label")} <input name="text" required autocomplete="off" placeholder="${escapeHtml(t(lang, "quickAdd.hint"))}" /></label>
  <button type="submit">${t(lang, "todo.add")}</button>
</form>`;
}

export interface TodoPageOptions {
  today: string;
  timezone: string | undefined;
  /** The device Member, for the Mina toggle; undefined hides it. */
  me: Member | undefined;
  mine: boolean;
  doneCount: number;
  notice?: string;
  /** The Activity disclosure, rendered by the caller. */
  activityHtml?: string;
  /** The Todo just Quick Added and its phrase, marked once on its row. */
  added?: { id: number } & QuickAddEcho;
}

/** The Mina / Alla toggle, present only when the device has a Member. */
function mineToggle(lang: Lang, list: List, me: Member | undefined, mine: boolean): string {
  if (!me) return "";
  return `<nav class="list-filter actions" aria-label="${t(lang, "todo.member")}"><a class="button" href="/lists/${list.id}"${mine ? "" : ' aria-current="true"'}>${t(lang, "todo.all")}</a><a class="button" href="/lists/${list.id}?mine=1"${mine ? ' aria-current="true"' : ""}>${t(lang, "todo.mine")}</a></nav>`;
}

export function todoListPage(lang: Lang, ctx: AppContext, list: List, todos: Todo[], opts: TodoPageOptions): string {
  const members = listMembers(ctx.db);
  const shown = opts.mine && opts.me ? todos.filter((todo) => todo.memberId === opts.me!.id) : todos;
  const rows = shown.length === 0 ? `<p class="notice">${t(lang, "lists.empty")}</p>` : `<ul class="rows" id="todos">\n${shown.map((todo) => todoRow(lang, todo, members, { today: opts.today, timezone: opts.timezone, ...(opts.added?.id === todo.id ? { quickAdd: opts.added } : {}) })).join("\n")}\n</ul>`;
  const body = `${listHead(lang, list)}
${opts.notice ? notice({ text: opts.notice, role: "status" }) : ""}
${todoAddForm(lang, list)}
${mineToggle(lang, list, opts.me, opts.mine)}
${rows}
${listClearControl(lang, list, opts.doneCount)}
${opts.activityHtml ?? ""}`;
  return page({ title: listName(lang, list), body, lang, tab: "lists" });
}

/** The Repeat field: a kind, then the weekdays, the count or the day the kind needs. */
function repeatFields(lang: Lang, repeat: RepeatRule | null, hasDue: boolean): string {
  const kind = repeat?.kind ?? "none";
  const options = ["none", ...REPEAT_KINDS].map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${t(lang, `todo.repeat.${k}` as MessageKey)}</option>`).join("");
  const weekdays = repeat?.kind === "weekly" ? repeat.weekdays : [];
  const chips = WEEKDAYS.map((d) => `<label class="chip"><input type="checkbox" name="repeat_weekdays" value="${d}"${weekdays.includes(d) ? " checked" : ""} /> ${escapeHtml(weekdayName(lang, d, "short"))}</label>`).join("\n    ");
  const n = repeat?.kind === "every_n_weeks" ? repeat.n : 2;
  const day = repeat?.kind === "monthly" ? repeat.day : 1;
  const hint = hasDue ? "" : `<p class="muted">${t(lang, "todo.repeat.needsDue")}</p>`;
  return `<fieldset>
    <legend>${t(lang, "todo.repeat")}</legend>
    ${hint}
    <label>${t(lang, "todo.repeat")} <select name="repeat_kind">${options}</select></label>
    <div class="repeat-weekdays">${chips}</div>
    <label>${t(lang, "todo.repeat.n")} <input type="number" name="repeat_n" min="2" value="${n}" /></label>
    <label>${t(lang, "todo.repeat.day")} <input type="number" name="repeat_day" min="1" max="31" value="${day}" /></label>
  </fieldset>`;
}

export function todoEditPage(lang: Lang, ctx: AppContext, list: List, todo: Todo, done: DoneRecord[], error?: string): string {
  const members = listMembers(ctx.db);
  const timezone = readTimezone(ctx.db);
  const history =
    done.length === 0
      ? ""
      : `<h2>${t(lang, "todo.doneHistory")}</h2>
<ul class="rows">
${done.map((d) => `<li class="row"><span class="row-status">${escapeHtml(d.memberName ? t(lang, "todo.doneBy", { name: d.memberName, time: shortWhen(lang, d.doneAt, timezone) }) : shortWhen(lang, d.doneAt, timezone))}</span></li>`).join("\n")}
</ul>`;
  const endRepeat = todo.repeat ? `<form method="post" action="/todos/${todo.id}/repeat/end"><button type="submit" class="quiet">${t(lang, "todo.repeat.end")}</button></form>` : "";
  const body = `<header class="page-head"><h1>${t(lang, "todo.editTitle")}</h1></header>
${error ? notice({ text: error }) : ""}
<form method="post" action="/todos/${todo.id}">
  <label>${t(lang, "todo.title")} <input name="title" required value="${escapeHtml(todo.title)}" /></label>
  <label>${t(lang, "todo.notes")} <textarea name="notes" rows="3">${escapeHtml(todo.notes ?? "")}</textarea></label>
  <label>${t(lang, "todo.due")} <input type="date" name="due_date" value="${escapeHtml(todo.dueDate ?? "")}" /></label>
  <label>${t(lang, "todo.dueTime")} <input type="time" name="due_time" value="${escapeHtml(todo.dueTime ?? "")}" /></label>
  ${memberSelect(lang, members, todo.memberId)}
  ${repeatFields(lang, todo.repeat, todo.dueDate !== null)}
  <div class="actions"><button type="submit">${t(lang, "common.save")}</button></div>
</form>
<div class="actions">${endRepeat}<form method="post" action="/todos/${todo.id}/delete"><button type="submit" class="quiet">${t(lang, "common.delete")}</button></form></div>
${history}
<p><a href="${listHref(list)}">${escapeHtml(listName(lang, list))}</a></p>`;
  return page({ title: t(lang, "todo.editTitle"), body, lang, tab: "lists" });
}

/** "14:02" today, "igår 14:02", "tis 14:02" this past week, "tis 13 okt 14:02" before that. */
function activityWhen(lang: Lang, at: string, today: string, timezone: string | undefined): string {
  const date = localDate(new Date(at), timezone);
  const time = localTime(new Date(at), timezone);
  if (date === today) return time;
  if (date === addDays(today, -1)) return `${t(lang, "activity.yesterday")} ${time}`;
  if (date > addDays(today, -7)) return shortWhen(lang, at, timezone);
  return `${shortDate(lang, date)} ${time}`;
}

function activityText(lang: Lang, row: ActivityRow): string {
  const who = row.memberName ?? t(lang, "activity.someone");
  switch (row.action) {
    case "planned":
      return t(lang, row.itemName === "1" ? "activity.planned.one" : "activity.planned.other", { n: row.itemName });
    case "cleared":
      return t(lang, row.itemName === "1" ? "activity.cleared.one" : "activity.cleared.other", { who, n: row.itemName });
    default:
      return t(lang, `activity.${row.action}`, { who, name: row.itemName });
  }
}

/** "Aktivitet": who did what on the List in the last 30 days, newest first, closed by default. */
export function activityDisclosure(lang: Lang, rows: ActivityRow[], today: string, timezone: string | undefined): string {
  const items =
    rows.length === 0
      ? `<p class="muted">${t(lang, "activity.empty")}</p>`
      : `<ul class="rows activity-rows">
${rows.map((row) => `<li class="row"><span class="row-status">${escapeHtml(t(lang, "activity.row", { text: activityText(lang, row), when: activityWhen(lang, row.at, today, timezone) }))}</span></li>`).join("\n")}
</ul>`;
  return `<details class="activity">
<summary>${t(lang, "activity.title")}</summary>
${items}
</details>`;
}
