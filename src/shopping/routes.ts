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
import { escapeHtml, NAV, page } from "../ui/layout.js";
import type { AggregatedItem } from "./aggregate.js";
import { pushShoppingList } from "../sinks/push.js";
import { latestPushes } from "../sinks/repo.js";
import { buildShoppingList, getShoppingList } from "./build.js";

NAV.push({ href: "/shopping", label: "Shopping" });

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

function renderSection(id: string, heading: string, items: AggregatedItem[]): string {
  const list = items.length === 0 ? `<p class="notice">Nothing here</p>` : `<ul>${items.map(renderItem).join("")}</ul>`;
  return `<section id="${id}"><h2>${heading}</h2>${list}</section>`;
}

function buildForm(weekStart: string, label: string): string {
  return `<form method="post" action="/shopping/build">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit">${label}</button>
</form>`;
}

function renderPushes(ctx: { db: import("better-sqlite3").Database }, planId: number, weekStart: string): string {
  const rows = latestPushes(ctx.db, planId)
    .map((p) =>
      p.ok
        ? `<li class="push-ok">${escapeHtml(p.sinkId)}: pushed${p.detail ? ` (${escapeHtml(p.detail)})` : ""}</li>`
        : `<li class="push-error">${escapeHtml(p.sinkId)}: push failed: ${escapeHtml(p.error ?? "unknown error")}</li>`,
    )
    .join("");
  return `<section id="sinks"><h2>Sinks</h2>${rows ? `<ul>${rows}</ul>` : `<p class="notice">Not pushed anywhere</p>`}
<form method="post" action="/shopping/push">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit">Push again</button>
</form></section>`;
}

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const weekStart = resolveWeek(req.query.week, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    let content: string;
    if (!plan) {
      content = `<p class="notice">No plan for this week. <a href="/plan?week=${weekStart}">Go to the plan</a> to generate one.</p>`;
    } else {
      const { buy, checkPantry } = getShoppingList(ctx.db, plan.id);
      content =
        buy.length + checkPantry.length === 0
          ? `<p class="notice">No Shopping List yet.</p>
${buildForm(weekStart, "Build shopping list")}`
          : `${renderSection("buy", "Buy", buy)}
${renderSection("check-pantry", "Check pantry", checkPantry)}
${buildForm(weekStart, "Rebuild shopping list")}
${renderPushes(ctx, plan.id, weekStart)}`;
    }
    const body = `<h1>Shopping List</h1>
<p>
  <a href="/shopping?week=${addDays(weekStart, -7)}">Previous week</a>
  Week of <time datetime="${weekStart}">${weekStart}</time>
  <a href="/shopping?week=${addDays(weekStart, 7)}">Next week</a>
</p>
${content}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: "Shopping List", body });
  });

  app.post<{ Body: BuildForm }>("/shopping/build", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) { await buildShoppingList(ctx, plan.id); await pushShoppingList(ctx, plan.id); }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  app.post<{ Body: BuildForm }>("/shopping/push", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await pushShoppingList(ctx, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
