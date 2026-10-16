/**
 * Shopping List view (FR-11, FR-17): the stored list for one week's Weekly Plan in two
 * sections, "Buy" and "Check pantry", with a rebuild action. Building also happens
 * automatically after plan generation (src/plan/routes.ts and src/server.ts).
 */
import type { FeaturePlugin } from "../app.js";
import { addDays } from "../lunch/week.js";
import { getPlanForWeek } from "../planner/repo.js";
import { mondayOf } from "../planner/week.js";
import { localDate } from "../today/routes.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";
import type { AggregatedItem } from "./aggregate.js";
import { buildShoppingList, getShoppingList } from "./build.js";

NAV.push({ href: "/shopping", label: "nav.shopping" });

const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

interface ShoppingQuery {
  week?: string;
}

interface BuildForm {
  weekStart?: string;
}

function resolveWeek(raw: string | undefined, today: string): string {
  return mondayOf(raw && WEEK_START.test(raw) ? raw : today);
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

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const lang = langOf(req);
    const weekStart = resolveWeek(req.query.week, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    let content: string;
    if (!plan) {
      content = `<p class="notice">${t(lang, "shopping.noPlan")} <a href="/plan?week=${weekStart}">${t(lang, "shopping.goToPlan")}</a> ${t(lang, "shopping.toGenerate")}</p>`;
    } else {
      const { buy, checkPantry } = getShoppingList(ctx.db, plan.id);
      content =
        buy.length + checkPantry.length === 0
          ? `<p class="notice">${t(lang, "shopping.none")}</p>
${buildForm(weekStart, t(lang, "shopping.build"))}`
          : `${renderSection(lang, "buy", t(lang, "shopping.buy"), buy)}
${renderSection(lang, "check-pantry", t(lang, "shopping.checkPantry"), checkPantry)}
${buildForm(weekStart, t(lang, "shopping.rebuild"))}`;
    }
    const body = `<h1>${t(lang, "shopping.title")}</h1>
<p>
  <a href="/shopping?week=${addDays(weekStart, -7)}">${t(lang, "week.prev")}</a>
  ${t(lang, "week.of")} <time datetime="${weekStart}">${weekStart}</time>
  <a href="/shopping?week=${addDays(weekStart, 7)}">${t(lang, "week.next")}</a>
</p>
${content}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "shopping.title"), body, lang });
  });

  app.post<{ Body: BuildForm }>("/shopping/build", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await buildShoppingList(ctx, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
