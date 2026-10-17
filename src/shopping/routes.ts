/**
 * Shopping List view (FR-11, FR-17): the stored list for one week's Weekly Plan in two
 * sections, "Buy" and "Check pantry", with a rebuild action. Building also happens
 * automatically after plan generation (src/plan/routes.ts and src/server.ts). The week's
 * Plan Run banner explains a half-built list; Build/Rebuild and Har alltid hemma are withheld
 * (and refused over HTTP) while that run is in flight.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
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
import { configuredSinks } from "../sinks/registry.js";
import { buildShoppingList, buyFingerprint, getMissingDishIds, getShoppingList } from "./build.js";
import { createPantryItem, deletePantryItem, listPantryItems } from "../pantry/repo.js";
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

interface UndoForm extends BuildForm {
  id?: string;
}

/** The Pantry Item Har alltid hemma just created: its line under Kolla skafferiet offers Ångra. */
interface Undo {
  id: number;
  name: string;
}

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

/** Ångra on a Kolla skafferiet line: deletes the Pantry Item just created and rebuilds. */
function undoForm(lang: Lang, weekStart: string, undo: Undo): string {
  return `<form method="post" action="/shopping/pantry/undo" hx-post="/shopping/pantry/undo" hx-target="#shopping-lists" hx-swap="outerHTML">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <input type="hidden" name="id" value="${undo.id}" />
  <button type="submit" class="quiet" data-working-label="…">${t(lang, "shopping.undo")}</button>
</form>`;
}

function buildForm(weekStart: string, label: string): string {
  return `<form method="post" action="/shopping/build">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit" class="quiet">${label}</button>
</form>`;
}

/**
 * The Köp and Kolla skafferiet sections in one swappable wrapper. With `undo`, the matching
 * Kolla skafferiet line offers Ångra, and a placeholder fetches the plain sections after a few seconds.
 */
function renderLists(lang: Lang, ctx: AppContext, planId: number, weekStart: string, opts: { alwaysHome: boolean; undo?: Undo }): string {
  const { buy, checkPantry } = getShoppingList(ctx.db, planId);
  const dishName = (id: number) => getDish(ctx.db, id)?.name;
  const { undo } = opts;
  const buyAction = opts.alwaysHome ? (item: AggregatedItem) => alwaysHomeForm(lang, weekStart, item) : undefined;
  const pantryAction = undo ? (item: AggregatedItem) => (item.name.toLowerCase() === undo.name.toLowerCase() ? undoForm(lang, weekStart, undo) : undefined) : undefined;
  const expire = undo ? `\n<div hidden hx-get="/shopping/sections?week=${weekStart}" hx-trigger="load delay:6s" hx-target="#shopping-lists" hx-swap="outerHTML"></div>` : "";
  return `<div id="shopping-lists">
${renderSection(lang, dishName, "buy", t(lang, "shopping.buy"), buy, buyAction)}
${renderSection(lang, dishName, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry, pantryAction)}${expire}
</div>`;
}

/** Inverted status block naming the planned Dishes with no Ingredients; Försök igen unless a Plan Run is in flight. */
function renderMissing(lang: Lang, weekStart: string, names: string[], retry: boolean): string {
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
 * successful push, a line says so, since the sink no longer holds the current list.
 */
function renderPushes(lang: Lang, ctx: AppContext, planId: number, weekStart: string, buy: AggregatedItem[]): string {
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
  if (pushes.length === 0 && configuredSinks(ctx.db, ctx.env ?? process.env, ctx.fetch).length === 0) {
    return `<section id="sinks">\n<p class="sink-status"><a href="/settings#recipients">${t(lang, "shopping.noSink")}</a></p>\n</section>`;
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
    let content: string;
    if (!plan) {
      content = `<p class="notice">${t(lang, "shopping.noPlan")} <a href="/plan?week=${weekStart}">${t(lang, "shopping.goToPlan")}</a> ${t(lang, "shopping.toGenerate")}</p>`;
    } else {
      const { buy, checkPantry } = getShoppingList(ctx.db, plan.id);
      const missing = renderMissing(lang, weekStart, getMissingDishIds(ctx.db, plan.id).flatMap((id) => dishName(id) ?? []), !runInFlight);
      content =
        buy.length + checkPantry.length === 0
          ? `${missing}<p class="notice">${t(lang, "shopping.none")}</p>
${rebuild(t(lang, "shopping.build"))}`
          : `${missing}
${renderLists(lang, ctx, plan.id, weekStart, { alwaysHome: !runInFlight })}
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
  // Försök igen: a rebuild. Dishes that resolved are cached, so only the ones without Ingredients reach the agent again.
  const rebuild = async (req: FastifyRequest<{ Body: BuildForm }>, reply: FastifyReply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(runInProgress(weekStart), 303);
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) {
      const deps = { ...ctx, log: runLogger(ctx.log, req, "shopping"), language: langOf(req) };
      await buildShoppingList(deps, plan.id);
      await pushShoppingList(deps, plan.id);
    }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  };
  app.post<{ Body: BuildForm }>("/shopping/build", rebuild);
  app.post<{ Body: BuildForm }>("/shopping/retry", rebuild);

  const isHtmx = (req: FastifyRequest) => req.headers["hx-request"] === "true";
  /** A refused change: HTMX navigates to the notice page, a plain form redirects there. */
  const refuse = (req: FastifyRequest, reply: FastifyReply, weekStart: string) => {
    if (!isHtmx(req)) return reply.redirect(runInProgress(weekStart), 303);
    return reply.header("HX-Redirect", runInProgress(weekStart)).code(204).send();
  };
  const sendLists = (req: FastifyRequest, reply: FastifyReply, weekStart: string, undo?: Undo) => {
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (!isHtmx(req) || !plan) return reply.redirect(`/shopping?week=${weekStart}`, 303);
    reply.type("text/html; charset=utf-8");
    return reply.send(renderLists(langOf(req), ctx, plan.id, weekStart, { alwaysHome: true, undo }));
  };
  const rebuildDeps = (req: FastifyRequest) => ({ ...ctx, log: runLogger(ctx.log, req, "shopping"), language: langOf(req) });

  app.post<{ Body: PantryForm }>("/shopping/pantry", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return refuse(req, reply, weekStart);
    const name = req.body.name?.trim();
    let undo: Undo | undefined;
    if (name) {
      const existing = listPantryItems(ctx.db).some((p) => p.name.toLowerCase() === name.toLowerCase());
      // Ångra only removes an item this tap created.
      if (!existing) undo = { id: createPantryItem(ctx.db, { name, aliases: [] }).id, name };
      const plan = getPlanForWeek(ctx.db, weekStart);
      if (plan) await buildShoppingList(rebuildDeps(req), plan.id);
    }
    return sendLists(req, reply, weekStart, undo);
  });

  app.post<{ Body: UndoForm }>("/shopping/pantry/undo", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return refuse(req, reply, weekStart);
    const id = Number(req.body.id);
    if (Number.isInteger(id)) {
      deletePantryItem(ctx.db, id);
      const plan = getPlanForWeek(ctx.db, weekStart);
      if (plan) await buildShoppingList(rebuildDeps(req), plan.id);
    }
    return sendLists(req, reply, weekStart);
  });

  app.get<{ Querystring: ShoppingQuery }>("/shopping/sections", async (req, reply) => {
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    return sendLists(req, reply, weekStart);
  });

  app.post<{ Body: BuildForm }>("/shopping/push", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await pushShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") }, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
