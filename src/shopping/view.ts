/**
 * The Shopping List page's parts (FR-11, FR-17, ADR-0007): the Buy and Check pantry sections
 * as a to-do list (a tick on every line, Har alltid hemma and Ångra, a remove control on every
 * Dish-derived line, the Extra Item add row and delete), the "N removed" disclosure, the
 * missing-Ingredients block, the sink status lines and the Build form. src/shopping/routes.ts
 * assembles them per request.
 */
import type { AppContext } from "../app.js";
import { readTimezone } from "../planner/settings.js";
import { t, type Lang } from "../i18n/index.js";
import { getDish } from "../dishes/repo.js";
import { escapeHtml, notice } from "../ui/layout.js";
import { shortWhen } from "../ui/when.js";
import type { AggregatedItem } from "./aggregate.js";
import { latestPushes } from "../sinks/repo.js";
import { configuredSinks } from "../sinks/registry.js";
import { buyFingerprint, getShoppingList } from "./build.js";
import type { ShoppingLine } from "./edits.js";
import type { PantryItem } from "../pantry/repo.js";
import { pantryLookup } from "../pantry/matching.js";
import { normaliseName } from "../text.js";

/** The Pantry Item Har alltid hemma just created: its line under Check pantry offers Ångra. */
export type Undo = PantryItem;

/** "pasta" / "400 g pasta" as the row's main text. */
function itemLabel(item: AggregatedItem): string {
  const amount = item.quantity === null ? "" : `${item.quantity}${item.unit ? ` ${item.unit}` : ""} `;
  return `${amount}${item.name}`;
}

/** A one-button form posting the week and a line's name to a Shopping List edit route. */
function lineForm(action: string, weekStart: string, name: string, button: string): string {
  return `<form method="post" action="${action}">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="name" value="${escapeHtml(name)}" />
  ${button}
</form>`;
}

/** Quiet "har alltid hemma" form on a Buy line: makes a Pantry Item of the line's name. */
function alwaysHomeForm(lang: Lang, weekStart: string, item: AggregatedItem): string {
  return `<form method="post" action="/shopping/pantry" hx-post="/shopping/pantry" hx-target="#shopping-lists" hx-swap="outerHTML">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="name" value="${escapeHtml(item.name)}" />
  <button type="submit" class="quiet" data-working-label="…" aria-label="${escapeHtml(t(lang, "shopping.alwaysHomeFor", { name: item.name }))}">${t(lang, "shopping.alwaysHome")}</button>
</form>`;
}

/** Ångra on a Check pantry line: deletes the Pantry Item just created and rebuilds. */
function undoForm(lang: Lang, weekStart: string, undo: Undo): string {
  return `<form method="post" action="/shopping/pantry/undo" hx-post="/shopping/pantry/undo" hx-target="#shopping-lists" hx-swap="outerHTML">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="id" value="${undo.id}" />
  <button type="submit" class="quiet" data-working-label="…">${t(lang, "shopping.undo")}</button>
</form>`;
}

/** Takes a Dish-derived line off this week's list ("we already have this"). */
function removeForm(lang: Lang, weekStart: string, line: ShoppingLine): string {
  const button = `<button type="submit" class="quiet" aria-label="${escapeHtml(t(lang, "shopping.removeFor", { name: line.name }))}">${t(lang, "shopping.remove")}</button>`;
  return lineForm("/shopping/remove", weekStart, line.name, button);
}

/** Deletes an Extra Item outright (no restore). */
function deleteExtraForm(lang: Lang, weekStart: string, line: ShoppingLine): string {
  return `<form method="post" action="/shopping/extra/delete">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="id" value="${line.extraId}" />
  <button type="submit" class="quiet" aria-label="${escapeHtml(t(lang, "shopping.deleteExtraFor", { name: line.name }))}">${t(lang, "common.delete")}</button>
</form>`;
}

/** The add row at the end of Buy: a name and an optional free-text quantity. */
function addExtraForm(lang: Lang, weekStart: string): string {
  return `<form method="post" action="/shopping/extra" class="extra-add">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <label>${t(lang, "shopping.extraName")} <input name="name" required /></label>
  <label>${t(lang, "shopping.extraQuantity")} <input name="quantity" /></label>
  <button type="submit">${t(lang, "shopping.addExtra")}</button>
</form>`;
}

/** The tick: checks an open line, unchecks a Checked Off one. */
function tickForm(lang: Lang, weekStart: string, line: ShoppingLine): string {
  const key = line.checked ? "shopping.uncheck" : "shopping.check";
  const button = `<button type="submit" class="tick" aria-label="${escapeHtml(t(lang, key, { name: line.name }))}" aria-pressed="${line.checked}"></button>`;
  return lineForm(line.checked ? "/shopping/uncheck" : "/shopping/check", weekStart, line.name, button);
}

function renderLine(lang: Lang, dishName: (id: number) => string | undefined, weekStart: string, line: ShoppingLine, actions: string[]): string {
  const dishes = line.sourceDishIds.flatMap((id) => dishName(id) ?? []);
  const till = dishes.length === 0 ? "" : `\n<span class="row-status">${escapeHtml(t(lang, "shopping.till", { dishes: dishes.join(", ") }))}</span>`;
  const label = line.checked ? `<s class="row-label">${escapeHtml(itemLabel(line))}</s>` : `<span class="row-label">${escapeHtml(itemLabel(line))}</span>`;
  const end = actions.length ? `\n<div class="line-end">${actions.join("\n")}</div>` : "";
  return `<li class="row line${line.checked ? " line-checked" : ""}"${lineKeys(line)}>${tickForm(lang, weekStart, line)}<div class="line-body">${label}${till}</div>${end}</li>`;
}

/**
 * How the Offline Copy overlay (public/offline/core.js) finds a line: the normalised name the
 * edit routes key on, and an Extra Item's id for its delete.
 */
function lineKeys(line: ShoppingLine): string {
  const extra = line.extraId === undefined ? "" : ` data-extra="${line.extraId}"`;
  return ` data-line="${escapeHtml(normaliseName(line.name))}"${extra}`;
}

function renderSection(lang: Lang, dishName: (id: number) => string | undefined, weekStart: string, id: string, heading: string, lines: ShoppingLine[], actions: (line: ShoppingLine) => string[], tail = ""): string {
  const list = lines.length === 0 ? `<p class="sink-status">${t(lang, "shopping.nothing")}</p>` : `<ul class="rows">\n${lines.map((l) => renderLine(lang, dishName, weekStart, l, actions(l))).join("\n")}\n</ul>`;
  return `<section id="${id}"><h2 class="section-label">${heading}</h2>\n${list}${tail}</section>`;
}

/** "N removed", closed by default, listing each Removed Line with a restore control. Empty when none. */
function renderRemoved(lang: Lang, weekStart: string, removed: ShoppingLine[]): string {
  if (removed.length === 0) return "";
  const rows = removed.map((line) => {
    const button = `<button type="submit" class="quiet" aria-label="${escapeHtml(t(lang, "shopping.restoreFor", { name: line.name }))}">${t(lang, "shopping.restore")}</button>`;
    return `<li class="row with-actions"${lineKeys(line)}><span class="row-label">${escapeHtml(itemLabel(line))}</span><div class="row-actions">${lineForm("/shopping/restore", weekStart, line.name, button)}</div></li>`;
  });
  return `\n<details id="removed">
<summary>${escapeHtml(t(lang, removed.length === 1 ? "count.removed.one" : "count.removed.other", { n: removed.length }))}</summary>
<ul class="rows">
${rows.join("\n")}
</ul>
</details>`;
}

export function buildForm(weekStart: string, label: string): string {
  return `<form method="post" action="/shopping/build">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit" class="quiet">${label}</button>
</form>`;
}

/**
 * The Buy and Check pantry sections and the removed disclosure in one swappable wrapper. With
 * `undo`, the matching Check pantry line offers Ångra, and a placeholder fetches the plain
 * sections after a few seconds. Every Dish-derived line can be removed for the week; an Extra
 * Item is deleted instead.
 */
export function renderLists(lang: Lang, ctx: AppContext, planId: number, weekStart: string, opts: { alwaysHome: boolean; undo?: Undo }): string {
  const { buy, checkPantry, removed } = getShoppingList(ctx.db, planId);
  const dishName = (id: number) => getDish(ctx.db, id)?.name;
  const { undo } = opts;
  const isUndoLine = undo ? pantryLookup([undo]) : undefined;
  const buyActions = (line: ShoppingLine) =>
    line.extraId !== undefined ? [deleteExtraForm(lang, weekStart, line)] : [...(opts.alwaysHome ? [alwaysHomeForm(lang, weekStart, line)] : []), removeForm(lang, weekStart, line)];
  const pantryActions = (line: ShoppingLine) => [...(undo && isUndoLine?.(line.name) ? [undoForm(lang, weekStart, undo)] : []), removeForm(lang, weekStart, line)];
  const expire = undo ? `\n<div hidden hx-get="/shopping/sections?week=${weekStart}" hx-trigger="load delay:6s" hx-target="#shopping-lists" hx-swap="outerHTML"></div>` : "";
  return `<div id="shopping-lists">
${renderSection(lang, dishName, weekStart, "buy", t(lang, "shopping.buy"), buy, buyActions, `\n${addExtraForm(lang, weekStart)}`)}
${renderSection(lang, dishName, weekStart, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, pantryActions)}${renderRemoved(lang, weekStart, removed)}${expire}
</div>`;
}

/** Inverted status block naming the planned Dishes with no Ingredients; Försök igen unless a Plan Run is in flight. */
export function renderMissing(lang: Lang, weekStart: string, names: string[], retry: boolean): string {
  if (names.length === 0) return "";
  const actionsHtml = retry
    ? `<form method="post" action="/shopping/retry">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit">${t(lang, "shopping.retry")}</button>
</form>`
    : undefined;
  return notice({ text: t(lang, "shopping.missing", { dishes: names.join(", ") }), role: "status", actionsHtml });
}

function sinkName(sinkId: string): string {
  return sinkId.charAt(0).toUpperCase() + sinkId.slice(1);
}

/**
 * Where and when the Buy list went: one status line per sink, or an inverted block per failure;
 * Skicka igen once. When a rebuild (Swap, Har alltid hemma) changed the Buy list after a
 * successful push, a line says so, since the sink no longer holds the current list. With no
 * sink configured, the history stays but the last line links to Settings instead of Skicka igen.
 */
export function renderPushes(lang: Lang, ctx: AppContext, planId: number, weekStart: string, buy: ShoppingLine[]): string {
  const timezone = readTimezone(ctx.db);
  const pushes = latestPushes(ctx.db, planId);
  const hasSink = configuredSinks(ctx.db, ctx.env ?? process.env, ctx.fetch).length > 0;
  const again = (quiet: boolean) => `<form method="post" action="/shopping/push">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
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
