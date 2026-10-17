/**
 * Plan view (FR-17): the Weekly Plan for one Monday–Sunday week with each day's lunch
 * context (FR-5) and each Planned Dinner's rationale (FR-8), plus the plan lifecycle (FR-9/9a):
 * generate, confirm (lock from automatic changes), and regenerate (re-check menus, warn when a
 * stored Lunch Entry changed, ask again before replacing a confirmed plan).
 */
import type Database from "better-sqlite3";
import type { AppContext, FeaturePlugin } from "../app.js";
import { getDish } from "../dishes/repo.js";
import { suggestedBadge } from "../dishes/suggested-badge.js";
import { addDays, mondayOf, weekDates, weekdayOf } from "../week.js";
import { householdToday } from "../planner/settings.js";
import { ingestWeek, type LunchChange } from "../lunch/ingest.js";
import { noLunchNotice, type NoLunchNotice } from "../lunch/notice.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { getSchool } from "../schools/repo.js";
import { generatePlan, type GeneratePlanResult } from "../planner/generate.js";
import { runLogger, type Logger } from "../logging/logger.js";
import type { OnProgress } from "../plan-run/phase.js";
import { logPlanRunProgress } from "../plan-run/progress-log.js";
import { logPlanSummary } from "../planner/summary.js";
import { confirmPlan, getPlanForWeek, type PlannedDinner, type WeeklyPlan } from "../planner/repo.js";
import { buildShoppingList } from "../shopping/build.js";
import { pushShoppingList } from "../sinks/push.js";
import { langOf, t, weekdayName, type Lang } from "../i18n/index.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";

NAV.push({ href: "/plan", label: "nav.plan" });

const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

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

function renderLunch(notice: NoLunchNotice, lang: Lang, date: string, { school, entry }: SchoolLunch): string {
  const body = entry
    ? `<ul>${entry.rawText
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => `<li>${escapeHtml(line.trim())}</li>`)
        .join("")}</ul>`
    : notice(lang, date, school);
  return `<article class="school-lunch"><h4>${escapeHtml(school.name)}</h4>${body}</article>`;
}

function renderDinner(db: Database.Database, lang: Lang, dinner: PlannedDinner | undefined): string {
  if (!dinner) return `<p class="notice">${t(lang, "plan.noDinner")}</p>`;
  const dish = dinner.dishId === null ? undefined : getDish(db, dinner.dishId);
  const name = dish ? `<strong>${escapeHtml(dish.name)}</strong>` : `<span class="notice">${t(lang, "common.noEligibleDish")}</span>`;
  return `<p class="dinner">${name}${suggestedBadge(lang, dish)}</p>
<p class="rationale">${escapeHtml(dinner.rationale)}</p>`;
}

function renderDay(db: Database.Database, notice: NoLunchNotice, lang: Lang, date: string, dinner: PlannedDinner | undefined): string {
  const weekday = weekdayName(lang, weekdayOf(date));
  const quick = dinner?.isQuickDay ? ` <span class="quick-day">${t(lang, "plan.quickDay")}</span>` : "";
  const lunches = listLunchForDate(db, date);
  const lunch =
    lunches.length === 0
      ? notice(lang, date)
      : lunches.map((l) => renderLunch(notice, lang, date, l)).join("\n");
  return `<article class="plan-day">
  <h3>${weekday} <time datetime="${date}">${date}</time>${quick}</h3>
  <section class="lunch"><h4>${t(lang, "common.lunch")}</h4>${lunch}</section>
  <section class="dinner"><h4>${t(lang, "common.dinner")}</h4>${renderDinner(db, lang, dinner)}</section>
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

function renderPlan(db: Database.Database, lang: Lang, weekStart: string, plan: WeeklyPlan): string {
  const byDate = new Map(plan.dinners.map((d) => [d.date, d]));
  const notice = noLunchNotice(db);
  const degraded =
    plan.degradedReasons.length === 0
      ? ""
      : `<p class="notice">${t(lang, "plan.degraded")}: ${plan.degradedReasons.map(escapeHtml).join("; ")}</p>`;
  const changedDates = datesWithChangedLunch(db, plan);
  const lunchChanged =
    changedDates.length === 0 ? "" : `<p class="notice">${t(lang, "plan.notice.lunch-changed")}: ${changedDates.join(", ")}</p>`;
  return `<p>${t(lang, "plan.status")}: ${escapeHtml(t(lang, `plan.status.${plan.status}`))}</p>
${plan.status === "generated" ? weekForm(weekStart, "/plan/confirm", t(lang, "plan.confirm")) : ""}
${weekForm(weekStart, "/plan/regenerate", t(lang, "plan.regenerate"))}
${degraded}
${lunchChanged}
${weekDates(weekStart)
  .map((date) => renderDay(db, notice, lang, date, byDate.get(date)))
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

function renderNoPlan(lang: Lang, weekStart: string): string {
  return `<p class="notice">${t(lang, "plan.none")}</p>
${weekForm(weekStart, "/plan/generate", t(lang, "plan.generate"))}`;
}

/** FR-9a: a confirmed plan is only replaced after the user says so again. */
function renderConfirmRegenerate(lang: Lang, weekStart: string): string {
  return `<h1>${t(lang, "plan.regenerate")}</h1>
<p class="notice">${t(lang, "plan.confirmedIntro")} <time datetime="${weekStart}">${weekStart}</time>.</p>
${weekForm(weekStart, "/plan/regenerate", t(lang, "plan.replaceConfirmed"), { confirmed_override: "1" })}
<p><a href="/plan?week=${weekStart}">${t(lang, "plan.keepConfirmed")}</a></p>`;
}

const NOTICES = {
  confirmed: "plan.notice.confirmed",
  "plan-confirmed": "plan.notice.plan-confirmed",
  "lunch-changed": "plan.notice.lunch-changed",
} as const;

function isNotice(key: string | undefined): key is keyof typeof NOTICES {
  return key !== undefined && Object.hasOwn(NOTICES, key);
}

function logRunFinished(log: Logger, weekStart: string, result: GeneratePlanResult, started: number, extra: Record<string, unknown> = {}): void {
  const outcome = "planId" in result ? { planId: result.planId, degradedReasons: result.degradedReasons.length } : { skipped: result.skipped };
  log.info({ weekStart, ...outcome, ...extra, durationMs: Date.now() - started }, "run finished");
}

async function finishPlan(
  ctx: AppContext,
  log: Logger,
  onProgress: OnProgress,
  result: { planId: number; degradedReasons: string[] },
): Promise<void> {
  const deps = { ...ctx, log, onProgress };
  await buildShoppingList(deps, result.planId);
  const sinksPushed = await pushShoppingList(deps, result.planId);
  logPlanSummary(log, ctx.db, result.planId, result.degradedReasons, sinksPushed);
}

export const planRoutes: FeaturePlugin = async (app, ctx) => {
  // Read the ports at run time: `ctx.llm` follows the Settings agent command.
  const ingestDeps = () => ({ db: ctx.db, llm: ctx.llm, fetchPage: ctx.fetchPage, now: ctx.now });

  app.get<{ Querystring: PlanQuery }>("/plan", async (req, reply) => {
    const lang = langOf(req);
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    let notice = isNotice(req.query.notice) ? t(lang, NOTICES[req.query.notice]) : undefined;
    if (req.query.notice === "lunch-changed") {
      const changes = describeChanges(ctx.db, req.query.changed);
      notice = `${t(lang, NOTICES["lunch-changed"])}${changes.length ? `: ${changes.join(", ")}` : ""}`;
    }
    const body = `<h1>${t(lang, "plan.heading")}</h1>
<p>
  <a href="/plan?week=${addDays(weekStart, -7)}">${t(lang, "week.prev")}</a>
  ${t(lang, "week.of")} <time datetime="${weekStart}">${weekStart}</time>
  <a href="/plan?week=${addDays(weekStart, 7)}">${t(lang, "week.next")}</a>
</p>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
${plan ? renderPlan(ctx.db, lang, weekStart, plan) : renderNoPlan(lang, weekStart)}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "plan.title"), body, lang });
  });

  app.post<{ Body: GenerateForm }>("/plan/generate", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const log = runLogger(ctx.log, req, "plan");
    const started = Date.now();
    log.info({ weekStart, trigger: "generate" }, "run started");
    const onProgress = logPlanRunProgress(log, weekStart);
    // Lunch must be stored before planning or the category collision rule (FR-6b) has nothing to check.
    const { changed } = await ingestWeek({ ...ingestDeps(), log, onProgress }, weekStart);
    const result = await generatePlan(
      { db: ctx.db, llm: ctx.llm, now: () => ctx.now().toISOString(), log, onProgress },
      weekStart,
      { replace: false },
    );
    logRunFinished(log, weekStart, result, started, { lunchChanged: changed.length });
    const notice = "skipped" in result ? `&notice=${result.skipped}` : "";
    if ("planId" in result) await finishPlan(ctx, log, onProgress, result); // Shopping List follows the plan (FR-11), then sinks (FR-13)
    return reply.redirect(`/plan?week=${weekStart}${notice}`, 303);
  });

  // FR-9 / Q17: manual regenerate re-checks the school menus (forced ingest), replaces the
  // week's plan, and reports stored Lunch Entries that changed. No silent re-plan.
  app.post<{ Body: RegenerateForm }>("/plan/regenerate", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (getPlanForWeek(ctx.db, weekStart)?.status === "confirmed" && !req.body.confirmed_override) {
      const lang = langOf(req);
      reply.type("text/html; charset=utf-8");
      return page({ title: t(lang, "plan.regenerate"), body: renderConfirmRegenerate(lang, weekStart), lang });
    }
    const log = runLogger(ctx.log, req, "plan");
    const started = Date.now();
    log.info({ weekStart, trigger: "regenerate" }, "run started");
    const onProgress = logPlanRunProgress(log, weekStart);
    const { changed } = await ingestWeek({ ...ingestDeps(), log, onProgress }, weekStart, { force: true });
    const result = await generatePlan(
      { db: ctx.db, llm: ctx.llm, now: () => ctx.now().toISOString(), log, onProgress },
      weekStart,
      { replace: true },
    );
    logRunFinished(log, weekStart, result, started, { lunchChanged: changed.length });
    if ("planId" in result) await finishPlan(ctx, log, onProgress, result); // Shopping List follows the plan (FR-11), then sinks (FR-13)
    const notice = changed.length === 0 ? "" : `&notice=lunch-changed&changed=${encodeChanges(changed)}`;
    return reply.redirect(`/plan?week=${weekStart}${notice}`, 303);
  });

  // FR-9a: lock the week's plan from automatic changes.
  app.post<{ Body: GenerateForm }>("/plan/confirm", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    confirmPlan(ctx.db, weekStart);
    return reply.redirect(`/plan?week=${weekStart}&notice=plan-confirmed`, 303);
  });
};
