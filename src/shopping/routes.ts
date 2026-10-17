/**
 * Shopping List view (FR-11, FR-17): the stored list for one week's Weekly Plan in two
 * sections, "Buy" and "Check pantry", with a rebuild action. Building also happens
 * automatically after plan generation (src/plan/routes.ts and src/server.ts). The week's
 * Plan Run banner explains a half-built list; Build/Rebuild is withheld while that run is in flight.
 */
import type { FeaturePlugin } from "../app.js";
import { runLogger } from "../logging/logger.js";
import { addDays, resolveWeek } from "../week.js";
import { householdToday } from "../planner/settings.js";
import { getPlanForWeek } from "../planner/repo.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";
import type { AggregatedItem } from "./aggregate.js";
import { pushShoppingList } from "../sinks/push.js";
import { latestPushes } from "../sinks/repo.js";
import { buildShoppingList, getShoppingList } from "./build.js";
import { planRunBanner } from "../plan-run/routes.js";

NAV.push({ href: "/shopping", label: "nav.shopping" });

interface ShoppingQuery {
  week?: string;
}

interface BuildForm {
  weekStart?: string;
}

function renderItem(item: AggregatedItem): string {
  const amount = item.quantity === null ? "" : `${item.quantity}${item.unit ? ` ${item.unit}` : ""} `;
  return `<li>${escapeHtml(amount)}${escapeHtml(item.name)}</li>`;
}

function renderSection(lang: Lang, id: string, heading: string, items: AggregatedItem[]): string {
  const list = items.length === 0 ? `<p class="notice">${t(lang, "shopping.nothing")}</p>` : `<ul>${items.map(renderItem).join("")}</ul>`;
  return `<section id="${id}"><h2>${heading}</h2>${list}</section>`;
}

function buildForm(weekStart: string, label: string): string {
  return `<form method="post" action="/shopping/build">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit">${label}</button>
</form>`;
}

function renderPushes(lang: Lang, ctx: { db: import("better-sqlite3").Database }, planId: number, weekStart: string): string {
  const rows = latestPushes(ctx.db, planId)
    .map((p) =>
      p.ok
        ? `<li class="push-ok">${escapeHtml(p.sinkId)}: ${t(lang, "shopping.pushed")}${p.detail ? ` (${escapeHtml(p.detail)})` : ""}</li>`
        : `<li class="push-error">${escapeHtml(p.sinkId)}: ${t(lang, "shopping.pushFailed")} ${escapeHtml(p.error ?? t(lang, "shopping.unknownError"))}</li>`,
    )
    .join("");
  return `<section id="sinks"><h2>${t(lang, "shopping.sinks")}</h2>${rows ? `<ul>${rows}</ul>` : `<p class="notice">${t(lang, "shopping.notPushed")}</p>`}
<form method="post" action="/shopping/push">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit">${t(lang, "shopping.pushAgain")}</button>
</form></section>`;
}

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const lang = langOf(req);
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    const runInFlight = ctx.planRuns.isInFlight(weekStart);
    /** The Build or Rebuild form, or nothing while the week's Plan Run is in flight. */
    const buildFormUnlessInFlight = (label: string) => (runInFlight ? "" : buildForm(weekStart, label));
    let content: string;
    if (!plan) {
      content = `<p class="notice">${t(lang, "shopping.noPlan")} <a href="/plan?week=${weekStart}">${t(lang, "shopping.goToPlan")}</a> ${t(lang, "shopping.toGenerate")}</p>`;
    } else {
      const { buy, checkPantry } = getShoppingList(ctx.db, plan.id);
      content =
        buy.length + checkPantry.length === 0
          ? `<p class="notice">${t(lang, "shopping.none")}</p>
${buildFormUnlessInFlight(t(lang, "shopping.build"))}`
          : `${renderSection(lang, "buy", t(lang, "shopping.buy"), buy)}
${renderSection(lang, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry)}
${buildFormUnlessInFlight(t(lang, "shopping.rebuild"))}
${renderPushes(lang, ctx, plan.id, weekStart)}`;
    }
    const body = `<h1>${t(lang, "shopping.title")}</h1>
<p>
  <a href="/shopping?week=${addDays(weekStart, -7)}">${t(lang, "week.prev")}</a>
  ${t(lang, "week.of")} <time datetime="${weekStart}">${weekStart}</time>
  <a href="/shopping?week=${addDays(weekStart, 7)}">${t(lang, "week.next")}</a>
</p>
${planRunBanner(ctx, lang, weekStart)}
${content}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "shopping.title"), body, lang });
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

  app.post<{ Body: BuildForm }>("/shopping/push", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await pushShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") }, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
