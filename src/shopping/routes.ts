/**
 * Shopping List view (FR-11, FR-17): the stored list for one week's Weekly Plan in two
 * sections, "Buy" and "Check pantry", with a rebuild action. Building also happens
 * automatically after plan generation (src/plan/routes.ts and src/server.ts). The week's
 * Plan Run banner explains a half-built list; Build/Rebuild and Har alltid hemma are withheld
 * (and refused over HTTP) while that run is in flight.
 */
import type { AppContext, FeaturePlugin } from "../app.js";
import { runLogger } from "../logging/logger.js";
import { resolveWeek } from "../week.js";
import { householdToday, readTimezone } from "../planner/settings.js";
import { getPlanForWeek } from "../planner/repo.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { getDish } from "../dishes/repo.js";
import { weekHead, weekNav } from "../ui/almanac.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { shortWhen } from "../ui/when.js";
import type { AggregatedItem } from "./aggregate.js";
import { pushShoppingList } from "../sinks/push.js";
import { latestPushes } from "../sinks/repo.js";
import { buildShoppingList, buyFingerprint, getShoppingList } from "./build.js";
import { addExtraItem, checkLine, deleteExtraItem, uncheckLine, type ShoppingLine } from "./edits.js";
import { createPantryItem, listPantryItems } from "../pantry/repo.js";
import { planRunBanner } from "../plan-run/routes.js";

interface ShoppingQuery {
  week?: string;
  notice?: string;
}

const NOTICES = { "run-in-progress": "shopping.notice.run-in-progress" } as const;

function queryNotice(lang: Lang, key: string | undefined): string {
  return key !== undefined && Object.hasOwn(NOTICES, key) ? notice({ text: t(lang, NOTICES[key as keyof typeof NOTICES]), role: "status" }) : "";
}

/** Where a refused change returns: the week's list with the run-in-progress notice. */
function runInProgress(weekStart: string): string {
  return `/shopping?week=${weekStart}&notice=run-in-progress`;
}

interface BuildForm {
  weekStart?: string;
}

interface PantryForm extends BuildForm {
  name?: string;
}

/** Check, uncheck, remove and restore post the week and the line's name. */
type LineForm = PantryForm;

interface ExtraForm extends LineForm {
  quantity?: string;
}

interface ExtraDeleteForm extends BuildForm {
  id?: string;
}

/** "pasta" / "400 g pasta" as the row's main text. */
function itemLabel(item: AggregatedItem): string {
  const amount = item.quantity === null ? "" : `${item.quantity}${item.unit ? ` ${item.unit}` : ""} `;
  return `${amount}${item.name}`;
}

/** Quiet "har alltid hemma" form on a Buy line: makes a Pantry Item of the line's name. */
function alwaysHomeForm(lang: Lang, weekStart: string, item: AggregatedItem): string {
  return `<form method="post" action="/shopping/pantry">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="name" value="${escapeHtml(item.name)}" />
  <button type="submit" class="quiet" aria-label="${escapeHtml(t(lang, "shopping.alwaysHomeFor", { name: item.name }))}">${t(lang, "shopping.alwaysHome")}</button>
</form>`;
}

/** A one-button form posting the week and a line's name to a Shopping List edit route. */
function lineForm(action: string, weekStart: string, name: string, button: string): string {
  return `<form method="post" action="${action}">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="name" value="${escapeHtml(name)}" />
  ${button}
</form>`;
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
  const rowActions = actions.length ? `\n<div class="row-actions">${actions.join("\n")}</div>` : "";
  return `<li class="row line${line.checked ? " line-checked" : ""}">${tickForm(lang, weekStart, line)}<div class="line-body">${label}${till}${rowActions}</div></li>`;
}

function renderSection(lang: Lang, dishName: (id: number) => string | undefined, weekStart: string, id: string, heading: string, lines: ShoppingLine[], actions: (line: ShoppingLine) => string[], tail = ""): string {
  const list = lines.length === 0 ? `<p class="sink-status">${t(lang, "shopping.nothing")}</p>` : `<ul class="rows">\n${lines.map((l) => renderLine(lang, dishName, weekStart, l, actions(l))).join("\n")}\n</ul>`;
  return `<section id="${id}"><h2 class="section-label">${heading}</h2>\n${list}${tail}</section>`;
}

function buildForm(weekStart: string, label: string): string {
  return `<form method="post" action="/shopping/build">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit" class="quiet">${label}</button>
</form>`;
}

function sinkName(sinkId: string): string {
  return sinkId.charAt(0).toUpperCase() + sinkId.slice(1);
}

/**
 * Where and when the Buy list went: one status line per sink, or an inverted block per failure;
 * Skicka igen once. When a rebuild (Swap, Har alltid hemma) changed the Buy list after a
 * successful push, a line says so, since the sink no longer holds the current list.
 */
function renderPushes(lang: Lang, ctx: AppContext, planId: number, weekStart: string, buy: ShoppingLine[]): string {
  const timezone = readTimezone(ctx.db);
  const pushes = latestPushes(ctx.db, planId);
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
          actionsHtml: i === lastFailed ? again(false) : undefined,
        }),
  );
  const current = buyFingerprint(buy);
  const lastOk = pushes.reduce((last, p, i) => (p.ok ? i : last), -1);
  if (pushes.some((p) => p.ok && p.buyHash !== null && p.buyHash !== current)) {
    lines.splice(lastOk + 1, 0, `<p class="sink-status">${t(lang, "shopping.changedSinceSent")}</p>`);
  }
  if (pushes.length === 0) lines.push(`<p class="sink-status">${t(lang, "shopping.notPushed")}</p>`);
  if (lastFailed === -1) lines.push(again(true));
  return `<section id="sinks">\n${lines.join("\n")}\n</section>`;
}

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const lang = langOf(req);
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    const runInFlight = ctx.planRuns.isInFlight(weekStart);
    const dishName = (id: number) => getDish(ctx.db, id)?.name;
    /** The Build or Rebuild form, or nothing while the week's Plan Run is in flight. */
    const rebuild = (label: string) => (runInFlight ? "" : buildForm(weekStart, label));
    /** Har alltid hemma rebuilds the list, so it is withheld in flight too. */
    const alwaysHome = runInFlight ? undefined : (item: AggregatedItem) => alwaysHomeForm(lang, weekStart, item);
    let content: string;
    if (!plan) {
      content = `<p class="notice">${t(lang, "shopping.noPlan")} <a href="/plan?week=${weekStart}">${t(lang, "shopping.goToPlan")}</a> ${t(lang, "shopping.toGenerate")}</p>`;
    } else {
      const { buy, checkPantry } = getShoppingList(ctx.db, plan.id);
      /** An Extra Item can be deleted; a Dish-derived Buy line can become a Pantry Item. */
      const buyActions = (line: ShoppingLine) => (line.extraId !== undefined ? [deleteExtraForm(lang, weekStart, line)] : alwaysHome ? [alwaysHome(line)] : []);
      content =
        buy.length + checkPantry.length === 0
          ? `<p class="notice">${t(lang, "shopping.none")}</p>
${rebuild(t(lang, "shopping.build"))}`
          : `${renderSection(lang, dishName, weekStart, "buy", t(lang, "shopping.buy"), buy, buyActions, `\n${addExtraForm(lang, weekStart)}`)}
${renderSection(lang, dishName, weekStart, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, () => [])}
${rebuild(t(lang, "shopping.rebuild"))}
${renderPushes(lang, ctx, plan.id, weekStart, buy)}`;
    }
    const body = `${weekHead(lang, weekStart)}
${weekNav(lang, weekStart, "/shopping")}
${queryNotice(lang, req.query.notice)}
${planRunBanner(ctx, lang, weekStart)}
${content}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "shopping.title"), body, lang, tab: "shopping" });
  });

  // Build and Har alltid hemma rewrite the list the week's Plan Run is also writing, so both are refused in flight.
  app.post<{ Body: BuildForm }>("/shopping/build", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(runInProgress(weekStart), 303);
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) {
      const deps = { ...ctx, log: runLogger(ctx.log, req, "shopping"), language: langOf(req) };
      await buildShoppingList(deps, plan.id);
      await pushShoppingList(deps, plan.id);
    }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  app.post<{ Body: PantryForm }>("/shopping/pantry", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(runInProgress(weekStart), 303);
    const name = req.body.name?.trim();
    if (name) {
      if (!listPantryItems(ctx.db).some((p) => p.name.toLowerCase() === name.toLowerCase())) createPantryItem(ctx.db, { name, aliases: [] });
      const plan = getPlanForWeek(ctx.db, weekStart);
      if (plan) await buildShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping"), language: langOf(req) }, plan.id);
    }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  // The week's own edits (ADR-0007) touch no list rows, so they are allowed while a Plan Run is in flight.
  const lineEdit = (action: string, edit: (weekStart: string, name: string) => void) => {
    app.post<{ Body: LineForm }>(action, async (req, reply) => {
      const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
      const name = req.body.name?.trim();
      if (name) edit(weekStart, name);
      return reply.redirect(`/shopping?week=${weekStart}`, 303);
    });
  };
  lineEdit("/shopping/check", (weekStart, name) => checkLine(ctx.db, weekStart, name));
  lineEdit("/shopping/uncheck", (weekStart, name) => uncheckLine(ctx.db, weekStart, name));

  app.post<{ Body: ExtraForm }>("/shopping/extra", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const name = req.body.name?.trim();
    if (name) addExtraItem(ctx.db, weekStart, { name, quantity: req.body.quantity });
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  app.post<{ Body: ExtraDeleteForm }>("/shopping/extra/delete", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const id = Number(req.body.id);
    if (Number.isInteger(id)) deleteExtraItem(ctx.db, weekStart, id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  app.post<{ Body: BuildForm }>("/shopping/push", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await pushShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") }, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
