/**
 * The Shopping List page's parts (FR-11, FR-17, ADR-0009): the Buy and Check pantry sections of
 * the living list as a to-do list (a tap anywhere on a line ticks it; Buy grouped by Store
 * Section; the dinners and dates a line is for), the hand-add row with autocomplete at the top,
 * the count left to buy and the Redigera toggle that shows Har alltid hemma and Delete on every
 * line, the Clear control, the missing-Ingredients block and the sink status lines.
 * src/shopping/routes.ts assembles them per request. A line edit over HTMX swaps that one line in
 * place, so a ticked line stays under the thumb until the next page load sorts it last; the
 * count, the Clear control and the "Nyligen" tray follow out of band (`listExtras`).
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
import type { ClearedLine } from "../lists/activity.js";
import { STORE_SECTIONS, storeSectionOf } from "./store-sections.js";

/** What Har alltid hemma just did: the line moved, and the Pantry Item it created (none when one existed). */
export interface Undo {
  lineId: number;
  pantryId?: number;
}

/** The element `html` opens with, marked for an out-of-band swap (`how`: "true" replaces it, "innerHTML" keeps it, e.g. a live region). */
export function outOfBand(html: string, how: "true" | "innerHTML" = "true"): string {
  return html.replace(/^<([a-z0-9]+)/, `<$1 hx-swap-oob="${how}"`);
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

/**
 * A one-button form posting a line's id to a Shopping List edit route. Over HTMX it asks for that
 * line back (`part=line`) and swaps it in place, so the rest of the list never moves.
 */
function lineForm(action: string, lineId: number, button: string, extra = ""): string {
  return `<form method="post" action="${action}" hx-post="${action}" hx-target="closest li" hx-swap="outerHTML">
  <input type="hidden" name="id" value="${lineId}" />
  <input type="hidden" name="part" value="line" />${extra}
  ${button}
</form>`;
}

/**
 * Quiet "har alltid hemma" form on a Buy line: makes a Pantry Item of the line's name and moves the
 * line. Its button shares an id with the Ångra that replaces the line, so focus lands on Ångra.
 */
function alwaysHomeForm(lang: Lang, line: ShoppingLine): string {
  const button = `<button type="submit" class="quiet" id="home-${line.id}" data-working-label="…" aria-label="${escapeHtml(t(lang, "shopping.alwaysHomeFor", { name: line.name }))}">${t(lang, "shopping.alwaysHome")}</button>`;
  return lineForm("/shopping/pantry", line.id, button, `\n  <input type="hidden" name="name" value="${escapeHtml(line.name)}" />`);
}

/**
 * What stands where a Buy line was after Har alltid hemma: where it went, and Ångra, which deletes
 * the Pantry Item the tap created and puts the line back. It stays until the page next loads.
 */
export function movedNote(lang: Lang, undo: Undo, name: string): string {
  const pantry = undo.pantryId === undefined ? "" : `\n  <input type="hidden" name="pantryId" value="${undo.pantryId}" />`;
  const button = `<button type="submit" class="quiet" id="home-${undo.lineId}" data-working-label="…">${t(lang, "shopping.undo")}</button>`;
  return `<li class="row line-note"><span class="row-status" role="status">${escapeHtml(t(lang, "shopping.movedToPantry", { name }))}</span>${lineForm("/shopping/pantry/undo", undo.lineId, button, pantry)}</li>`;
}

/** Delete: the line goes for good (ADR-0009). */
function deleteForm(lang: Lang, line: ShoppingLine): string {
  const button = `<button type="submit" class="quiet" aria-label="${escapeHtml(t(lang, "shopping.deleteFor", { name: line.name }))}">${t(lang, "shopping.delete")}</button>`;
  return lineForm("/shopping/delete", line.id, button);
}

/** The tick: checks an open line, unchecks a Checked Off one. Its id keeps focus on it across the swap. */
function tickForm(lang: Lang, line: ShoppingLine): string {
  const key = line.checked ? "shopping.uncheck" : "shopping.check";
  const button = `<button type="submit" class="tick" id="tick-${line.id}" aria-label="${escapeHtml(t(lang, key, { name: line.name }))}" aria-pressed="${line.checked}"></button>`;
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

/** "Pappa 14:02" on a line a Member ticked. */
function doneBy(lang: Lang, line: ShoppingLine, timezone: string | undefined): string {
  if (!line.checked || !line.checkedBy || !line.checkedAt) return "";
  return `\n<span class="row-status line-done-by">${escapeHtml(t(lang, "todo.doneBy", { name: line.checkedBy, time: shortWhen(lang, line.checkedAt, timezone) }))}</span>`;
}

/** How a section renders its lines: their actions, the timezone for "Pappa 14:02", and the line just added (marked once). */
interface LineOptions {
  actions: (line: ShoppingLine) => string[];
  timezone: string | undefined;
  freshId?: number | undefined;
}

function renderLine(lang: Lang, dishName: (id: number) => string | undefined, line: ShoppingLine, opts: LineOptions): string {
  const label = line.checked ? `<s class="row-label">${escapeHtml(itemLabel(line))}</s>` : `<span class="row-label">${escapeHtml(itemLabel(line))}</span>`;
  const actions = opts.actions(line);
  const end = actions.length ? `\n<div class="line-end">${actions.join("\n")}</div>` : "";
  const fresh = opts.freshId === line.id ? " line-new" : "";
  return `<li class="row line${line.checked ? " line-checked" : ""}${fresh}" data-line="${line.id}" data-name="${escapeHtml(normaliseName(line.name))}">${tickForm(lang, line)}<div class="line-body">${label}${provenance(lang, dishName, line)}${doneBy(lang, line, opts.timezone)}</div>${end}</li>`;
}

function rows(lang: Lang, dishName: (id: number) => string | undefined, lines: ShoppingLine[], opts: LineOptions): string {
  return `<ul class="rows">\n${lines.map((l) => renderLine(lang, dishName, l, opts)).join("\n")}\n</ul>`;
}

function renderSection(lang: Lang, dishName: (id: number) => string | undefined, id: string, heading: string, lines: ShoppingLine[], opts: LineOptions): string {
  const list = lines.length === 0 ? `<p class="sink-status">${t(lang, "shopping.nothing")}</p>` : rows(lang, dishName, lines, opts);
  return `<section id="${id}">${heading ? `<h2 class="section-label">${heading}</h2>\n` : ""}${list}</section>`;
}

/**
 * Buy: the open lines grouped by Store Section in walking order, then the Checked Off lines
 * together under "Avbockade", so what is left to buy stays on top. A single group gets no
 * subheading: a lone "Övrigt" says nothing.
 */
function renderBuy(lang: Lang, dishName: (id: number) => string | undefined, lines: ShoppingLine[], opts: LineOptions): string {
  const open = lines.filter((l) => !l.checked);
  const checked = lines.filter((l) => l.checked);
  const groups: [string, ShoppingLine[]][] = STORE_SECTIONS.map((section) => [t(lang, `shopping.section.${section}`), open.filter((l) => storeSectionOf(l.name) === section)] as [string, ShoppingLine[]]);
  groups.push([t(lang, "shopping.section.checked"), checked]);
  const shown = groups.filter(([, ls]) => ls.length > 0);
  if (shown.length <= 1) return renderSection(lang, dishName, "buy", t(lang, "shopping.buy"), lines, opts);
  const body = shown.map(([heading, ls]) => `<h3 class="aisle-label">${escapeHtml(heading)}</h3>\n${rows(lang, dishName, ls, opts)}`).join("\n");
  return `<section id="buy"><h2 class="section-label">${t(lang, "shopping.buy")}</h2>\n${body}</section>`;
}

/**
 * The hand-add row at the top of the list: a name with autocomplete over Ingredients and Pantry
 * Items, and an optional free-text quantity. Over HTMX it swaps the lines in, empties itself and
 * puts focus back in the name, so the next item can be typed at once; the status line under it
 * says what was added and where. Without HTMX (or offline) it posts and the page reloads.
 */
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
  const reset = "if (event.detail.successful) { this.reset(); this.querySelector('[name=name]').focus(); }";
  return `<form method="post" action="/shopping/add" class="line-add" hx-post="/shopping/add" hx-target="#shopping-lists" hx-swap="outerHTML" hx-on::after-request="${reset}">${list}
  <label class="line-add-name"><span class="visually-hidden">${t(lang, "shopping.addName")}</span> <input name="name" required list="shopping-names" autocomplete="off" placeholder="${escapeHtml(t(lang, "shopping.addPlaceholder"))}" /></label>
  <datalist id="shopping-names">${options.join("")}</datalist>
  <label class="line-add-quantity"><span class="visually-hidden">${t(lang, "shopping.addQuantity")}</span> <input name="quantity" autocomplete="off" placeholder="${escapeHtml(t(lang, "shopping.quantityPlaceholder"))}" /></label>
  <button type="submit">${t(lang, "shopping.add")}</button>
  <p class="add-status" id="add-status" role="status"></p>
</form>`;
}

/**
 * "Nyligen": lines Cleared or Deleted from this List in the last 30 days and not on it now, as
 * quiet chips that add the line back with one tap. An empty wrapper when the tray is empty, so a
 * Delete can fill it out of band.
 */
export function recentTray(lang: Lang, listId: number, lines: ClearedLine[]): string {
  return `<div id="recent-tray">${trayBody(lang, listId, lines)}</div>`;
}

function trayBody(lang: Lang, listId: number, lines: ClearedLine[]): string {
  if (lines.length === 0) return "";
  const chips = lines
    .map((line) => {
      const quantity = line.quantity ? `\n    <input type="hidden" name="quantity" value="${escapeHtml(line.quantity)}" />` : "";
      return `<li><form method="post" action="/lists/${listId}/add">
    <input type="hidden" name="name" value="${escapeHtml(line.name)}" />${quantity}
    <button type="submit" class="chip" aria-label="${escapeHtml(t(lang, "shopping.recentAdd", { name: line.name }))}">${escapeHtml(line.quantity ? `${line.quantity} ${line.name}` : line.name)}</button>
  </form></li>`;
    })
    .join("\n");
  return `<section class="recent-tray" aria-labelledby="recent-${listId}">
<h2 class="section-label" id="recent-${listId}">${t(lang, "shopping.recent")}</h2>
<ul class="chips">
${chips}
</ul>
</section>`;
}

/** "Rensa avbockade (N)" leading to the confirmation page; an empty wrapper when no line is ticked, so a tick can fill it out of band. */
export function clearControl(lang: Lang, ctx: AppContext, listId = SHOPPING_LIST_ID): string {
  const n = countChecked(ctx.db, listId);
  const href = listId === SHOPPING_LIST_ID ? "/shopping/clear" : `/lists/${listId}/clear`;
  const link = n === 0 ? "" : `<a class="button quiet" href="${href}">${escapeHtml(t(lang, "shopping.clear", { n }))}</a>`;
  return `<p class="clear-control" id="clear-control">${link}</p>`;
}

/**
 * The bar over the lines: how many Buy lines are left (a polite live region, so a tick is
 * announced), and the Redigera toggle. The toggle is a checkbox: CSS shows Har alltid hemma and
 * Delete on every line only while it is checked, so the list in the store is ticks and names.
 */
export function listTools(lang: Lang, left?: string): string {
  const count = left === undefined ? "" : `<p class="list-count" id="list-count" role="status">${left}</p>`;
  return `<div class="list-tools">${count}
  <input type="checkbox" id="list-edit" class="edit-toggle" aria-label="${escapeHtml(t(lang, "shopping.editLabel"))}" />
  <label for="list-edit" class="button quiet edit-label" aria-hidden="true"><span class="when-off">${t(lang, "shopping.edit")}</span><span class="when-on">${t(lang, "shopping.editDone")}</span></label>
</div>`;
}

/** "28 kvar att köpa", "Allt är i korgen", or nothing when Buy is empty. */
export function leftToBuy(lang: Lang, buy: readonly ShoppingLine[]): string {
  if (buy.length === 0) return "";
  const open = buy.filter((l) => !l.checked).length;
  return open === 0 ? t(lang, "shopping.allInBasket") : t(lang, "shopping.left", { n: open });
}

/** The lines of another shopping-style List, or its empty notice, in the wrapper the add row swaps. */
export function renderPlainLines(lang: Lang, listId: number, lines: ShoppingLine[], timezone?: string, opts: { freshId?: number; empty?: string } = {}): string {
  const none = () => undefined;
  const body = lines.length === 0 && opts.empty ? `<p class="notice">${opts.empty}</p>` : renderSection(lang, none, "lines", "", lines, { actions: (line) => [deleteForm(lang, line)], timezone, freshId: opts.freshId });
  return `<div id="shopping-lists" data-list="${listId}">
${body}
</div>`;
}

/** One line of another shopping-style List, for a swap in place. */
export function renderPlainLine(lang: Lang, line: ShoppingLine, timezone?: string): string {
  return renderLine(lang, () => undefined, line, { actions: (l) => [deleteForm(lang, l)], timezone });
}

/** Every line of the Shopping List can be Deleted; Buy lines also offer Har alltid hemma. */
function shoppingActions(lang: Lang, section: "buy" | "check-pantry"): (line: ShoppingLine) => string[] {
  return section === "buy" ? (line) => [alwaysHomeForm(lang, line), deleteForm(lang, line)] : (line) => [deleteForm(lang, line)];
}

function dishNames(ctx: AppContext): (id: number) => string | undefined {
  return (id) => getDish(ctx.db, id)?.name;
}

/** The Check pantry section on its own, for an out-of-band swap after a line moved into or out of it. */
export function renderCheckPantry(lang: Lang, ctx: AppContext): string {
  const { checkPantry } = getShoppingList(ctx.db);
  return renderSection(lang, dishNames(ctx), "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, { actions: shoppingActions(lang, "check-pantry"), timezone: readTimezone(ctx.db) });
}

/** One Shopping List line as it renders in its section, for a swap in place; "" when it is gone. */
export function renderShoppingLine(lang: Lang, ctx: AppContext, lineId: number): string {
  const { buy, checkPantry } = getShoppingList(ctx.db);
  const inBuy = buy.find((l) => l.id === lineId);
  const line = inBuy ?? checkPantry.find((l) => l.id === lineId);
  if (!line) return "";
  return renderLine(lang, dishNames(ctx), line, { actions: shoppingActions(lang, inBuy ? "buy" : "check-pantry"), timezone: readTimezone(ctx.db) });
}

/**
 * The Buy and Check pantry sections in one swappable wrapper, or the empty notice in it. `freshId`
 * marks the line just hand-added.
 */
export function renderLists(lang: Lang, ctx: AppContext, opts: { freshId?: number } = {}): string {
  const { buy, checkPantry } = getShoppingList(ctx.db);
  if (buy.length + checkPantry.length === 0) {
    return `<div id="shopping-lists">
<p class="notice">${t(lang, "shopping.empty")} <a href="/plan">${t(lang, "shopping.goToPlan")}</a></p>
</div>`;
  }
  const dishName = dishNames(ctx);
  const timezone = readTimezone(ctx.db);
  return `<div id="shopping-lists">
${renderBuy(lang, dishName, buy, { actions: shoppingActions(lang, "buy"), timezone, freshId: opts.freshId })}
${renderSection(lang, dishName, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, { actions: shoppingActions(lang, "check-pantry"), timezone, freshId: opts.freshId })}
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
