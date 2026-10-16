/**
 * Plan view (FR-17): the Weekly Plan for one Monday–Sunday week with each day's lunch
 * context (FR-5) and each Planned Dinner's rationale (FR-8). Generation here is the minimal
 * "no plan yet" path; confirm/regenerate flows and the lunch-changed warning are #33.
 */
import type Database from "better-sqlite3";
import type { FeaturePlugin } from "../app.js";
import { getDish } from "../dishes/repo.js";
import { addDays } from "../lunch/week.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { generatePlan } from "../planner/generate.js";
import { getPlanForWeek, type PlannedDinner, type WeeklyPlan } from "../planner/repo.js";
import { datesOfWeek, mondayOf } from "../planner/week.js";
import { weekdayOf } from "../engine/filter.js";
import { buildShoppingList } from "../shopping/build.js";
import { localDate } from "../today/routes.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";

NAV.push({ href: "/plan", label: "Plan" });

const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_LABELS = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
} as const;

interface PlanQuery {
  week?: string;
  notice?: string;
}

interface GenerateForm {
  weekStart?: string;
}

/** The requested week's Monday; an absent or malformed `week` means the current week. */
function resolveWeek(raw: string | undefined, today: string): string {
  return mondayOf(raw && WEEK_START.test(raw) ? raw : today);
}

function renderLunch({ school, entry }: SchoolLunch): string {
  const body = entry
    ? `<ul>${entry.rawText
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => `<li>${escapeHtml(line.trim())}</li>`)
        .join("")}</ul>`
    : `<p class="notice">No lunch data</p>`;
  return `<article class="school-lunch"><h4>${escapeHtml(school.name)}</h4>${body}</article>`;
}

function renderDinner(db: Database.Database, dinner: PlannedDinner | undefined): string {
  if (!dinner) return `<p class="notice">No dinner planned</p>`;
  const dish = dinner.dishId === null ? undefined : getDish(db, dinner.dishId);
  const name = dish ? `<strong>${escapeHtml(dish.name)}</strong>` : `<span class="notice">No eligible dish, pick one</span>`;
  return `<p class="dinner">${name}</p>
<p class="rationale">${escapeHtml(dinner.rationale)}</p>`;
}

function renderDay(db: Database.Database, date: string, dinner: PlannedDinner | undefined): string {
  const weekday = WEEKDAY_LABELS[weekdayOf(date)];
  const quick = dinner?.isQuickDay ? ` <span class="quick-day">Quick Day</span>` : "";
  const lunches = listLunchForDate(db, date);
  const lunch =
    lunches.length === 0
      ? `<p class="notice">No lunch data</p>`
      : lunches.map(renderLunch).join("\n");
  return `<article class="plan-day">
  <h3>${weekday} <time datetime="${date}">${date}</time>${quick}</h3>
  <section class="lunch"><h4>Lunch</h4>${lunch}</section>
  <section class="dinner"><h4>Dinner</h4>${renderDinner(db, dinner)}</section>
</article>`;
}

function renderPlan(db: Database.Database, weekStart: string, plan: WeeklyPlan): string {
  const byDate = new Map(plan.dinners.map((d) => [d.date, d]));
  const degraded =
    plan.degradedReasons.length === 0
      ? ""
      : `<p class="notice">Degraded plan: ${plan.degradedReasons.map(escapeHtml).join("; ")}</p>`;
  return `<p>Status: ${escapeHtml(plan.status)}</p>
${degraded}
${datesOfWeek(weekStart)
  .map((date) => renderDay(db, date, byDate.get(date)))
  .join("\n")}`;
}

function renderNoPlan(weekStart: string): string {
  return `<p class="notice">No plan for this week.</p>
<form method="post" action="/plan/generate">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  <button type="submit">Generate plan</button>
</form>`;
}

const NOTICES: Record<string, string> = {
  confirmed: "This plan is confirmed and was not replaced.",
};

export const planRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: PlanQuery }>("/plan", async (req, reply) => {
    const weekStart = resolveWeek(req.query.week, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    const notice = req.query.notice ? NOTICES[req.query.notice] : undefined;
    const body = `<h1>Weekly Plan</h1>
<p>
  <a href="/plan?week=${addDays(weekStart, -7)}">Previous week</a>
  Week of <time datetime="${weekStart}">${weekStart}</time>
  <a href="/plan?week=${addDays(weekStart, 7)}">Next week</a>
</p>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
${plan ? renderPlan(ctx.db, weekStart, plan) : renderNoPlan(weekStart)}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: "Plan", body });
  });

  app.post<{ Body: GenerateForm }>("/plan/generate", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, localDate(ctx.now()));
    const result = await generatePlan(
      { db: ctx.db, llm: ctx.llm, now: () => ctx.now().toISOString() },
      weekStart,
      { replace: false },
    );
    const notice = "skipped" in result ? `&notice=${result.skipped}` : "";
    if ("planId" in result) await buildShoppingList(ctx, result.planId); // #31: Shopping List follows the plan (FR-11)
    return reply.redirect(`/plan?week=${weekStart}${notice}`, 303);
  });
};
