/**
 * Plan view (FR-17): the Weekly Plan for one Monday–Sunday week with each day's lunch
 * context (FR-5) and each Planned Dinner's rationale (FR-8), plus the plan lifecycle (FR-9/9a):
 * generate, confirm (lock from automatic changes), and regenerate (re-check menus, warn when a
 * stored Lunch Entry changed, ask again before replacing a confirmed plan).
 */
import type Database from "better-sqlite3";
import type { FeaturePlugin } from "../app.js";
import { getDish } from "../dishes/repo.js";
import { addDays } from "../lunch/week.js";
import { ingestWeek, type LunchChange } from "../lunch/ingest.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { getSchool } from "../schools/repo.js";
import { generatePlan } from "../planner/generate.js";
import { confirmPlan, getPlanForWeek, type PlannedDinner, type WeeklyPlan } from "../planner/repo.js";
import { datesOfWeek, mondayOf } from "../planner/week.js";
import { weekdayOf } from "../engine/filter.js";
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
  /** Lunch changes behind a `lunch-changed` notice: `<schoolId>:<date>` pairs, comma-separated. */
  changed?: string;
}

interface GenerateForm {
  weekStart?: string;
}

interface RegenerateForm extends GenerateForm {
  /** FR-9a: set when the user confirmed replacing a confirmed plan. */
  confirmed_override?: string;
}

/** The `changed` query value for lunch changes: `<schoolId>:<date>` pairs, comma-separated. */
function encodeChanges(changes: LunchChange[]): string {
  return changes.map((c) => `${c.schoolId}:${c.date}`).join(",");
}

/** Human-readable "School date" list for a `changed` query value; unknown Schools are skipped. */
function describeChanges(db: Database.Database, changed: string | undefined): string[] {
  if (!changed) return [];
  const out: string[] = [];
  for (const pair of changed.split(",")) {
    const [id, date] = pair.split(":");
    const school = id && /^\d+$/.test(id) ? getSchool(db, Number(id)) : undefined;
    if (school && date && WEEK_START.test(date)) out.push(`${school.name} ${date}`);
  }
  return out;
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

/**
 * Q17: dates whose Planned Dinner was chosen against lunch text that no longer matches the
 * stored Lunch Entries (same `rawText` join as `planWeek`'s `lunchThatDay`). Days planned
 * without lunch data are not "changed" when data arrives later.
 */
function datesWithChangedLunch(db: Database.Database, plan: WeeklyPlan): string[] {
  return plan.dinners
    .filter((dinner) => {
      if (dinner.lunchThatDay === null) return false;
      const current = listLunchForDate(db, dinner.date)
        .flatMap(({ entry }) => (entry ? [entry.rawText] : []))
        .join("; ");
      return current !== dinner.lunchThatDay;
    })
    .map((dinner) => dinner.date);
}

function renderPlan(db: Database.Database, weekStart: string, plan: WeeklyPlan): string {
  const byDate = new Map(plan.dinners.map((d) => [d.date, d]));
  const degraded =
    plan.degradedReasons.length === 0
      ? ""
      : `<p class="notice">Degraded plan: ${plan.degradedReasons.map(escapeHtml).join("; ")}</p>`;
  const changedDates = datesWithChangedLunch(db, plan);
  const lunchChanged =
    changedDates.length === 0 ? "" : `<p class="notice">${NOTICES["lunch-changed"]}: ${changedDates.join(", ")}</p>`;
  return `<p>Status: ${escapeHtml(plan.status)}</p>
${plan.status === "generated" ? weekForm(weekStart, "/plan/confirm", "Confirm plan") : ""}
${weekForm(weekStart, "/plan/regenerate", "Regenerate plan")}
${degraded}
${lunchChanged}
${datesOfWeek(weekStart)
  .map((date) => renderDay(db, date, byDate.get(date)))
  .join("\n")}`;
}

/** A one-button form posting the week to `action`; `hidden` adds extra hidden fields. */
function weekForm(weekStart: string, action: string, label: string, hidden: Record<string, string> = {}): string {
  const extra = Object.entries(hidden)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("\n  ");
  return `<form method="post" action="${action}">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  ${extra}<button type="submit">${escapeHtml(label)}</button>
</form>`;
}

function renderNoPlan(weekStart: string): string {
  return `<p class="notice">No plan for this week.</p>
${weekForm(weekStart, "/plan/generate", "Generate plan")}`;
}

/** FR-9a: a confirmed plan is only replaced after the user says so again. */
function renderConfirmRegenerate(weekStart: string): string {
  return `<h1>Regenerate plan</h1>
<p class="notice">This plan is confirmed. Regenerating replaces it for the week of <time datetime="${weekStart}">${weekStart}</time>.</p>
${weekForm(weekStart, "/plan/regenerate", "Replace confirmed plan", { confirmed_override: "1" })}
<p><a href="/plan?week=${weekStart}">Keep the confirmed plan</a></p>`;
}

const NOTICES: Record<string, string> = {
  confirmed: "This plan is confirmed and was not replaced.",
  "plan-confirmed": "Plan confirmed",
  "lunch-changed": "Lunch menu changed since this plan was made",
};

export const planRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: PlanQuery }>("/plan", async (req, reply) => {
    const weekStart = resolveWeek(req.query.week, localDate(ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    let notice = req.query.notice ? NOTICES[req.query.notice] : undefined;
    if (req.query.notice === "lunch-changed") {
      const changes = describeChanges(ctx.db, req.query.changed);
      notice = `${NOTICES["lunch-changed"]}${changes.length ? `: ${changes.join(", ")}` : ""}`;
    }
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
    return reply.redirect(`/plan?week=${weekStart}${notice}`, 303);
  });

  // FR-9 / Q17: manual regenerate re-checks the school menus (forced ingest), replaces the
  // week's plan, and reports stored Lunch Entries that changed. No silent re-plan.
  app.post<{ Body: RegenerateForm }>("/plan/regenerate", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, localDate(ctx.now()));
    if (getPlanForWeek(ctx.db, weekStart)?.status === "confirmed" && !req.body.confirmed_override) {
      reply.type("text/html; charset=utf-8");
      return page({ title: "Regenerate plan", body: renderConfirmRegenerate(weekStart) });
    }
    const { changed } = await ingestWeek(ctx, weekStart, { force: true });
    await generatePlan({ db: ctx.db, llm: ctx.llm, now: () => ctx.now().toISOString() }, weekStart, { replace: true });
    const notice = changed.length === 0 ? "" : `&notice=lunch-changed&changed=${encodeChanges(changed)}`;
    return reply.redirect(`/plan?week=${weekStart}${notice}`, 303);
  });

  // FR-9a: lock the week's plan from automatic changes.
  app.post<{ Body: GenerateForm }>("/plan/confirm", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, localDate(ctx.now()));
    confirmPlan(ctx.db, weekStart);
    return reply.redirect(`/plan?week=${weekStart}&notice=plan-confirmed`, 303);
  });
};
