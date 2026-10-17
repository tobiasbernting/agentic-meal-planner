/**
 * Shopping List view (FR-11, FR-17): the stored list for one week's Weekly Plan in two
 * sections, "Buy" and "Check pantry", with a rebuild action. Building also happens
 * automatically after plan generation (src/plan/routes.ts and src/server.ts). The week's
 * Plan Run banner explains a half-built list; Build/Rebuild is withheld while that run is in flight.
 */
import type { AppContext, FeaturePlugin } from "../app.js";
import { runLogger } from "../logging/logger.js";
import { mondayOf } from "../week.js";
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
import { buildShoppingList, getShoppingList } from "./build.js";
import { createPantryItem, listPantryItems } from "../pantry/repo.js";
import { planRunBanner } from "../plan-run/routes.js";

const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

interface ShoppingQuery {
  week?: string;
}

interface BuildForm {
  weekStart?: string;
}

interface PantryForm extends BuildForm {
  name?: string;
}

function resolveWeek(raw: string | undefined, today: string): string {
  return mondayOf(raw && WEEK_START.test(raw) ? raw : today);
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

function renderItem(lang: Lang, dishName: (id: number) => string | undefined, item: AggregatedItem, alwaysHome?: string): string {
  const dishes = item.sourceDishIds.flatMap((id) => dishName(id) ?? []);
  const till = dishes.length === 0 ? "" : `\n<span class="row-status">${escapeHtml(t(lang, "shopping.till", { dishes: dishes.join(", ") }))}</span>`;
  return `<li class="row"><span class="row-label">${escapeHtml(itemLabel(item))}</span>${till}${alwaysHome ? `\n<div class="row-actions">${alwaysHome}</div>` : ""}</li>`;
}

function renderSection(lang: Lang, dishName: (id: number) => string | undefined, id: string, heading: string, items: AggregatedItem[], alwaysHome?: (item: AggregatedItem) => string): string {
  const list = items.length === 0 ? `<p class="sink-status">${t(lang, "shopping.nothing")}</p>` : `<ul class="rows">\n${items.map((i) => renderItem(lang, dishName, i, alwaysHome?.(i))).join("\n")}\n</ul>`;
  return `<section id="${id}"><h2 class="section-label">${heading}</h2>\n${list}</section>`;
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

/** Where and when the Buy list went: one status line per sink, or an inverted block per failure; Skicka igen once. */
function renderPushes(lang: Lang, ctx: AppContext, planId: number, weekStart: string): string {
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
  if (pushes.length === 0) lines.push(`<p class="sink-status">${t(lang, "shopping.notPushed")}</p>`);
  if (lastFailed === -1) lines.push(again(true));
  return `<section id="sinks">\n${lines.join("\n")}\n</section>`;
}

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const lang = langOf(req);
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    const run = ctx.planRuns.get(weekStart);
    const dishName = (id: number) => getDish(ctx.db, id)?.name;
    const rebuild = (label: string) => (run && "inFlight" in run ? "" : buildForm(weekStart, label));
    let content: string;
    if (!plan) {
      content = `<p class="notice">${t(lang, "shopping.noPlan")} <a href="/plan?week=${weekStart}">${t(lang, "shopping.goToPlan")}</a> ${t(lang, "shopping.toGenerate")}</p>`;
    } else {
      const { buy, checkPantry } = getShoppingList(ctx.db, plan.id);
      content =
        buy.length + checkPantry.length === 0
          ? `<p class="notice">${t(lang, "shopping.none")}</p>
${rebuild(t(lang, "shopping.build"))}`
          : `${renderSection(lang, dishName, "buy", t(lang, "shopping.buy"), buy, (item) => alwaysHomeForm(lang, weekStart, item))}
${renderSection(lang, dishName, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry)}
${rebuild(t(lang, "shopping.rebuild"))}
${renderPushes(lang, ctx, plan.id, weekStart)}`;
    }
    const body = `${weekHead(lang, weekStart)}
${weekNav(lang, weekStart, "/shopping")}
${planRunBanner(ctx, lang, weekStart)}
${content}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "shopping.title"), body, lang, tab: "shopping" });
  });

  app.post<{ Body: BuildForm }>("/shopping/build", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) {
      const deps = { ...ctx, log: runLogger(ctx.log, req, "shopping") };
      await buildShoppingList(deps, plan.id);
      await pushShoppingList(deps, plan.id);
    }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  app.post<{ Body: PantryForm }>("/shopping/pantry", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const name = req.body.name?.trim();
    if (name) {
      if (!listPantryItems(ctx.db).some((p) => p.name.toLowerCase() === name.toLowerCase())) createPantryItem(ctx.db, { name, aliases: [] });
      const plan = getPlanForWeek(ctx.db, weekStart);
      if (plan) await buildShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") }, plan.id);
    }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  app.post<{ Body: BuildForm }>("/shopping/push", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await pushShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") }, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
