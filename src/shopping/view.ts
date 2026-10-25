/**
 * The Shopping List page's parts (FR-11, FR-17, ADR-0009): the Buy and Check pantry sections of
 * the living list as a to-do list (a tick on every line, the dinners and dates a line is for,
 * Har alltid hemma and Ångra, Delete on every line), the hand-add row with autocomplete, the
 * Clear control, the missing-Ingredients block and the sink status lines.
 * src/shopping/routes.ts assembles them per request.
 */
import type { AppContext } from "../app.js";
import { readTimezone } from "../planner/settings.js";
import { t, weekdayName, type Lang } from "../i18n/index.js";
import { getDish, listDishes } from "../dishes/repo.js";
import { escapeHtml, notice } from "../ui/layout.js";
import { shortWhen } from "../ui/when.js";
import { latestPushes } from "../sinks/repo.js";
import { configuredSinks } from "../sinks/registry.js";
import { listPantryItems } from "../pantry/repo.js";
import { normaliseName } from "../text.js";
import { weekdayOf } from "../week.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { buyFingerprint, getShoppingList, type ShoppingLine } from "./list.js";
import { countChecked } from "./edits.js";

/** What Har alltid hemma just did: the line moved, and the Pantry Item it created (none when one existed). */
export interface Undo {
  lineId: number;
  pantryId?: number;
}

/** "pasta" / "400 g pasta" as the row's main text. */
export function itemLabel(line: Pick<ShoppingLine, "name" | "quantity" | "unit">): string {
  const amount = line.quantity === null ? "" : `${line.quantity}${line.unit ? ` ${line.unit}` : ""} `;
  return `${amount}${line.name}`;
}

/** "tis 28 okt": the short weekday and the day with its short month, in the UI language. */
export function shortDate(lang: Lang, date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const month = new Intl.DateTimeFormat(lang === "sv" ? "sv-SE" : "en-GB", { month: "short", timeZone: "UTC" }).format(d).replace(/\.$/, "");
  return `${weekdayName(lang, weekdayOf(date), "short").toLowerCase()} ${d.getUTCDate()} ${month}`;
}

/** A one-button form posting a line's id to a Shopping List edit route, swapping the sections over HTMX. */
function lineForm(action: string, lineId: number, button: string, extra = ""): string {
  return `<form method="post" action="${action}" hx-post="${action}" hx-target="#shopping-lists" hx-swap="outerHTML">
  <input type="hidden" name="id" value="${lineId}" />${extra}
  ${button}
</form>`;
}

/** Quiet "har alltid hemma" form on a Buy line: makes a Pantry Item of the line's name and moves the line. */
function alwaysHomeForm(lang: Lang, line: ShoppingLine): string {
  const button = `<button type="submit" class="quiet" data-working-label="…" aria-label="${escapeHtml(t(lang, "shopping.alwaysHomeFor", { name: line.name }))}">${t(lang, "shopping.alwaysHome")}</button>`;
  return lineForm("/shopping/pantry", line.id, button, `\n  <input type="hidden" name="name" value="${escapeHtml(line.name)}" />`);
}

/** Ångra on the line Har alltid hemma just moved: deletes the Pantry Item it created and moves the line back. */
function undoForm(lang: Lang, undo: Undo): string {
  const pantry = undo.pantryId === undefined ? "" : `\n  <input type="hidden" name="pantryId" value="${undo.pantryId}" />`;
  const button = `<button type="submit" class="quiet" data-working-label="…">${t(lang, "shopping.undo")}</button>`;
  return lineForm("/shopping/pantry/undo", undo.lineId, button, pantry);
}

/** Delete: the line goes for good (ADR-0009). */
function deleteForm(lang: Lang, line: ShoppingLine): string {
  const button = `<button type="submit" class="quiet" aria-label="${escapeHtml(t(lang, "shopping.deleteFor", { name: line.name }))}">${t(lang, "shopping.delete")}</button>`;
  return lineForm("/shopping/delete", line.id, button);
}

/** The tick: checks an open line, unchecks a Checked Off one. */
function tickForm(lang: Lang, line: ShoppingLine): string {
  const key = line.checked ? "shopping.uncheck" : "shopping.check";
  const button = `<button type="submit" class="tick" aria-label="${escapeHtml(t(lang, key, { name: line.name }))}" aria-pressed="${line.checked}"></button>`;
  return lineForm(line.checked ? "/shopping/uncheck" : "/shopping/check", line.id, button);
}

/** "till: Tacos (tis 28 okt), Pasta (fre 31 okt)": the dinners a line is for, dated when the dinner still exists. */
function provenance(lang: Lang, dishName: (id: number) => string | undefined, line: ShoppingLine): string {
  const parts = line.dinners.flatMap(({ dishId, date }) => {
    const name = dishName(dishId);
    if (!name) return [];
    return [date ? t(lang, "shopping.tillOn", { dish: escapeHtml(name), date: shortDate(lang, date) }) : escapeHtml(name)];
  });
  return parts.length === 0 ? "" : `\n<span class="row-status">${t(lang, "shopping.till", { dishes: parts.join(", ") })}</span>`;
}

function renderLine(lang: Lang, dishName: (id: number) => string | undefined, line: ShoppingLine, actions: string[]): string {
  const label = line.checked ? `<s class="row-label">${escapeHtml(itemLabel(line))}</s>` : `<span class="row-label">${escapeHtml(itemLabel(line))}</span>`;
  const end = actions.length ? `\n<div class="line-end">${actions.join("\n")}</div>` : "";
  return `<li class="row line${line.checked ? " line-checked" : ""}" data-line="${line.id}" data-name="${escapeHtml(normaliseName(line.name))}">${tickForm(lang, line)}<div class="line-body">${label}${provenance(lang, dishName, line)}</div>${end}</li>`;
}

function renderSection(lang: Lang, dishName: (id: number) => string | undefined, id: string, heading: string, lines: ShoppingLine[], actions: (line: ShoppingLine) => string[]): string {
  const list = lines.length === 0 ? `<p class="sink-status">${t(lang, "shopping.nothing")}</p>` : `<ul class="rows">\n${lines.map((l) => renderLine(lang, dishName, l, actions(l))).join("\n")}\n</ul>`;
  return `<section id="${id}">${heading ? `<h2 class="section-label">${heading}</h2>\n` : ""}${list}</section>`;
}

/** The hand-add row: a name with autocomplete over Ingredients and Pantry Items, and an optional free-text quantity. */
export function addForm(lang: Lang, ctx: AppContext, listId = SHOPPING_LIST_ID): string {
  const seen = new Set<string>();
  const options: string[] = [];
  const offer = (name: string) => {
    const key = normaliseName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push(`<option value="${escapeHtml(name.trim())}"></option>`);
  };
  for (const item of listPantryItems(ctx.db)) {
    offer(item.name);
    item.aliases.forEach(offer);
  }
  for (const dish of listDishes(ctx.db)) dish.ingredients.forEach((i) => offer(i.name));
  const list = listId === SHOPPING_LIST_ID ? "" : `\n  <input type="hidden" name="listId" value="${listId}" />`;
  return `<form method="post" action="/shopping/add" class="line-add">${list}
  <label>${t(lang, "shopping.addName")} <input name="name" required list="shopping-names" autocomplete="off" /></label>
  <datalist id="shopping-names">${options.join("")}</datalist>
  <label>${t(lang, "shopping.addQuantity")} <input name="quantity" /></label>
  <button type="submit">${t(lang, "shopping.add")}</button>
</form>`;
}

/** "Rensa avbockade (N)" leading to the confirmation page; nothing when no line is ticked. */
export function clearControl(lang: Lang, ctx: AppContext, listId = SHOPPING_LIST_ID): string {
  const n = countChecked(ctx.db, listId);
  if (n === 0) return "";
  const href = listId === SHOPPING_LIST_ID ? "/shopping/clear" : `/lists/${listId}/clear`;
  return `<p class="clear-control"><a class="button quiet" href="${href}">${escapeHtml(t(lang, "shopping.clear", { n }))}</a></p>`;
}

/** Another shopping-style List: one plain section of lines with tick and Delete, in the Shopping page's markup. */
export function renderPlainLines(lang: Lang, listId: number, lines: ShoppingLine[]): string {
  const none = () => undefined;
  return `<div id="shopping-lists" data-list="${listId}">
${renderSection(lang, none, "lines", "", lines, (line) => [deleteForm(lang, line)])}
</div>`;
}

/**
 * The Buy and Check pantry sections in one swappable wrapper. With `undo`, the line Har alltid
 * hemma just moved offers Ångra, and a placeholder fetches the plain sections after a few
 * seconds. Every line can be Deleted; Buy lines also offer Har alltid hemma.
 */
export function renderLists(lang: Lang, ctx: AppContext, opts: { alwaysHome: boolean; undo?: Undo } = { alwaysHome: true }): string {
  const { buy, checkPantry } = getShoppingList(ctx.db);
  const dishName = (id: number) => getDish(ctx.db, id)?.name;
  const { undo } = opts;
  const buyActions = (line: ShoppingLine) => [...(opts.alwaysHome ? [alwaysHomeForm(lang, line)] : []), deleteForm(lang, line)];
  const pantryActions = (line: ShoppingLine) => [...(undo && undo.lineId === line.id ? [undoForm(lang, undo)] : []), deleteForm(lang, line)];
  const expire = undo ? `\n<div hidden hx-get="/shopping/sections" hx-trigger="load delay:6s" hx-target="#shopping-lists" hx-swap="outerHTML"></div>` : "";
  return `<div id="shopping-lists">
${renderSection(lang, dishName, "buy", t(lang, "shopping.buy"), buy, buyActions)}
${renderSection(lang, dishName, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, pantryActions)}${expire}
</div>`;
}

/** Inverted status block naming the planned Dishes with no Ingredients; Försök igen unless a Plan Run is in flight. */
export function renderMissing(lang: Lang, names: string[], retry: boolean): string {
  if (names.length === 0) return "";
  const actionsHtml = retry
    ? `<form method="post" action="/shopping/retry">
  <button type="submit">${t(lang, "shopping.retry")}</button>
</form>`
    : undefined;
  return notice({ text: t(lang, "shopping.missing", { dishes: names.join(", ") }), role: "status", actionsHtml });
}

function sinkName(sinkId: string): string {
  return sinkId.charAt(0).toUpperCase() + sinkId.slice(1);
}

/**
 * Where and when the open Buy lines went: one status line per sink, or an inverted block per
 * failure; Skicka igen once. When the open Buy list changed after a successful push, a line
 * says so, since the sink no longer holds the current list. With no sink configured, the
 * history stays but the last line links to Settings instead of Skicka igen.
 */
export function renderPushes(lang: Lang, ctx: AppContext, buy: ShoppingLine[]): string {
  const timezone = readTimezone(ctx.db);
  const pushes = latestPushes(ctx.db);
  const hasSink = configuredSinks(ctx.db, ctx.env ?? process.env, ctx.fetch).length > 0;
  const again = (quiet: boolean) => `<form method="post" action="/shopping/push">
  <button type="submit"${quiet ? ' class="quiet"' : ""}>${t(lang, "shopping.pushAgain")}</button>
</form>`;
  const lastFailed = pushes.reduce((last, p, i) => (p.ok ? last : i), -1);
  const lines = pushes.map((p, i) =>
    p.ok
      ? `<p class="sink-status">${escapeHtml(t(lang, "shopping.sentTo", { sink: sinkName(p.sinkId), when: shortWhen(lang, p.pushedAt, timezone) }))}</p>`
      : notice({
          label: t(lang, "shopping.failedLabel"),
          text: t(lang, "shopping.sendFailed", { sink: sinkName(p.sinkId), error: p.error ?? t(lang, "shopping.unknownError") }),
          role: "alert",
          actionsHtml: hasSink && i === lastFailed ? again(false) : undefined,
        }),
  );
  const current = buyFingerprint(buy);
  const lastOk = pushes.reduce((last, p, i) => (p.ok ? i : last), -1);
  if (pushes.some((p) => p.ok && p.buyHash !== null && p.buyHash !== current)) {
    lines.splice(lastOk + 1, 0, `<p class="sink-status">${t(lang, "shopping.changedSinceSent")}</p>`);
  }
  if (!hasSink) lines.push(`<p class="sink-status"><a href="/settings#recipients">${t(lang, "shopping.noSink")}</a></p>`);
  else if (pushes.length === 0) lines.push(`<p class="sink-status">${t(lang, "shopping.notPushed")}</p>`);
  if (hasSink && lastFailed === -1) lines.push(again(true));
  return `<section id="sinks">\n${lines.join("\n")}\n</section>`;
}
