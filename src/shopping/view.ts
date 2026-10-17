/**
 * The Shopping List page's parts (FR-11, FR-17): the Buy and Check pantry sections with their
 * Har alltid hemma and Ångra actions, the missing-Ingredients block, the sink status lines and
 * the Build form. src/shopping/routes.ts assembles them per request.
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
import type { PantryItem } from "../pantry/repo.js";
import { pantryLookup } from "../pantry/matching.js";

/** The Pantry Item Har alltid hemma just created: its line under Check pantry offers Ångra. */
export type Undo = PantryItem;

/** "pasta" / "400 g pasta" as the row's main text. */
function itemLabel(item: AggregatedItem): string {
  const amount = item.quantity === null ? "" : `${item.quantity}${item.unit ? ` ${item.unit}` : ""} `;
  return `${amount}${item.name}`;
}

/** Quiet "har alltid hemma" form on a Buy line: makes a Pantry Item of the line's name. */
function alwaysHomeForm(lang: Lang, weekStart: string, item: AggregatedItem): string {
  return `<form method="post" action="/shopping/pantry" hx-post="/shopping/pantry" hx-target="#shopping-lists" hx-swap="outerHTML">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="name" value="${escapeHtml(item.name)}" />
  <button type="submit" class="quiet" data-working-label="…" aria-label="${escapeHtml(t(lang, "shopping.alwaysHomeFor", { name: item.name }))}">${t(lang, "shopping.alwaysHome")}</button>
</form>`;
}

function renderItem(lang: Lang, dishName: (id: number) => string | undefined, item: AggregatedItem, action?: string): string {
  const dishes = item.sourceDishIds.flatMap((id) => dishName(id) ?? []);
  const till = dishes.length === 0 ? "" : `\n<span class="row-status">${escapeHtml(t(lang, "shopping.till", { dishes: dishes.join(", ") }))}</span>`;
  return `<li class="row line"><span class="row-label">${escapeHtml(itemLabel(item))}</span>${till}${action ? `\n<div class="line-end">${action}</div>` : ""}</li>`;
}

function renderSection(lang: Lang, dishName: (id: number) => string | undefined, id: string, heading: string, items: AggregatedItem[], action?: (item: AggregatedItem) => string | undefined): string {
  const list = items.length === 0 ? `<p class="sink-status">${t(lang, "shopping.nothing")}</p>` : `<ul class="rows">\n${items.map((i) => renderItem(lang, dishName, i, action?.(i))).join("\n")}\n</ul>`;
  return `<section id="${id}"><h2 class="section-label">${heading}</h2>\n${list}</section>`;
}

/** Ångra on a Check pantry line: deletes the Pantry Item just created and rebuilds. */
function undoForm(lang: Lang, weekStart: string, undo: Undo): string {
  return `<form method="post" action="/shopping/pantry/undo" hx-post="/shopping/pantry/undo" hx-target="#shopping-lists" hx-swap="outerHTML">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="id" value="${undo.id}" />
  <button type="submit" class="quiet" data-working-label="…">${t(lang, "shopping.undo")}</button>
</form>`;
}

export function buildForm(weekStart: string, label: string): string {
  return `<form method="post" action="/shopping/build">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit" class="quiet">${label}</button>
</form>`;
}

/**
 * The Buy and Check pantry sections in one swappable wrapper. With `undo`, the matching
 * Check pantry line offers Ångra, and a placeholder fetches the plain sections after a few seconds.
 */
export function renderLists(lang: Lang, ctx: AppContext, planId: number, weekStart: string, opts: { alwaysHome: boolean; undo?: Undo }): string {
  const { buy, checkPantry } = getShoppingList(ctx.db, planId);
  const dishName = (id: number) => getDish(ctx.db, id)?.name;
  const { undo } = opts;
  const buyAction = opts.alwaysHome ? (item: AggregatedItem) => alwaysHomeForm(lang, weekStart, item) : undefined;
  const isUndoLine = undo ? pantryLookup([undo]) : undefined;
  const pantryAction = undo && isUndoLine ? (item: AggregatedItem) => (isUndoLine(item.name) ? undoForm(lang, weekStart, undo) : undefined) : undefined;
  const expire = undo ? `\n<div hidden hx-get="/shopping/sections?week=${weekStart}" hx-trigger="load delay:6s" hx-target="#shopping-lists" hx-swap="outerHTML"></div>` : "";
  return `<div id="shopping-lists">
${renderSection(lang, dishName, "buy", t(lang, "shopping.buy"), buy, buyAction)}
${renderSection(lang, dishName, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, pantryAction)}${expire}
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
export function renderPushes(lang: Lang, ctx: AppContext, planId: number, weekStart: string, buy: AggregatedItem[]): string {
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
