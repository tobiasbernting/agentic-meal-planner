/**
 * Plan view (FR-17) as the almanac review page (spec #71): the ISO week landmark, week
 * navigation, status and controls, then the Weekly Plan's seven days as open almanac rows with
 * each day's lunch (FR-5) and each Planned Dinner's rationale (FR-8). Plus the plan lifecycle (FR-9/9a):
 * generate, confirm (lock from automatic changes), and regenerate (re-check menus, warn when a
 * stored Lunch Entry changed, ask again before replacing a confirmed plan).
 */
import type Database from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext, FeaturePlugin } from "../app.js";
import { almanac } from "../almanac/day.js";
import { addDays, isIsoDate, mondayOf, resolveWeek, weekDates } from "../week.js";
import { householdToday, readTimezone } from "../planner/settings.js";
import { ingestWeek } from "../lunch/ingest.js";
import { listLunchForDate } from "../lunch/repo.js";
import { generatePlan, type GeneratePlanResult } from "../planner/generate.js";
import { runLogger, type Logger } from "../logging/logger.js";
import type { OnProgress } from "../plan-run/phase.js";
import { launchPlanRun } from "../plan-run/launch.js";
import { planRunBanner } from "../plan-run/routes.js";
import { logPlanSummary } from "../planner/summary.js";
import { confirmPlan, getPlanForWeek, type WeeklyPlan } from "../planner/repo.js";
import { describeDegraded, type DegradedReason } from "../planner/degraded.js";
import { updateAndPushShoppingList } from "../shopping/update-and-push.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { weekHead, weekNav } from "../ui/almanac.js";
import { swapControl } from "../swap/routes.js";
import { escapeHtml, notice, page } from "../ui/layout.js";

interface PlanQuery {
  week?: string;
  notice?: string;
}

interface GenerateForm {
  weekStart?: string;
}

interface RegenerateForm extends GenerateForm {
  /** FR-9a: set when the user confirmed replacing a confirmed plan. */
  confirmed_override?: string;
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

/**
 * The week `/plan` shows: the requested one, or with no (valid) `week`, next week once a Weekly
 * Plan exists for it (the Sunday review), else this week.
 */
function defaultWeek(db: Database.Database, raw: string | undefined, today: string): string {
  if (isIsoDate(raw)) return resolveWeek(raw, today);
  const next = addDays(mondayOf(today), 7);
  return getPlanForWeek(db, next) ? next : mondayOf(today);
}

/**
 * Status, Bekräfta and Generera igen at the top of the page, then the plan-wide notices. The
 * buttons hide while the week's Plan Run is in flight.
 */
function renderPlanTop(db: Database.Database, lang: Lang, weekStart: string, plan: WeeklyPlan, runInFlight: boolean): string {
  // Only week-wide reasons (no agent, agent failed) sit here; the rest go on their day.
  const degraded = degradedNotices(lang, plan.degradedReasons, null);
  const changedDates = datesWithChangedLunch(db, plan);
  const lunchChanged =
    changedDates.length === 0 ? "" : notice({ text: `${t(lang, "plan.notice.lunch-changed")}: ${changedDates.join(", ")}` });
  const buttons = runInFlight
    ? ""
    : `${plan.status === "generated" ? weekForm(weekStart, "/plan/confirm", t(lang, "plan.confirm"), {}, "primary") : ""}${weekForm(weekStart, "/plan/regenerate", t(lang, "plan.regenerate"))}`;
  return `<section class="plan-status">
<p>${t(lang, "plan.status")}: ${escapeHtml(t(lang, `plan.status.${plan.status}`))}</p>
${buttons ? `<div class="actions">${buttons}</div>` : ""}
</section>
${degraded}
${lunchChanged}`;
}

function renderNoPlanTop(lang: Lang, weekStart: string, runInFlight: boolean): string {
  return `<section class="plan-status">
<p>${t(lang, "plan.none")}</p>
${runInFlight ? "" : `<div class="actions">${weekForm(weekStart, "/plan/generate", t(lang, "plan.generate"), {}, "primary")}</div>`}
</section>`;
}

/**
 * The seven almanac rows, all open (density `full`). Per-day hooks for later tickets:
 * `swapHtml` takes the Swap control (#81; empty when Swap is unavailable) and
 * `extraHtml` the day's degraded reasons (#80). Each row lists the Todos due that day (ADR-0010).
 */
function renderDays(ctx: AppContext, lang: Lang, weekStart: string, today: string): string {
  const next = `/plan?week=${weekStart}`;
  const days = almanac(ctx.db, lang, { today, timezone: readTimezone(ctx.db), next });
  const reasons = getPlanForWeek(ctx.db, weekStart)?.degradedReasons ?? [];
  return weekDates(weekStart)
    .map((date) =>
      days.day({
        date,
        density: "full",
        today: date === today,
        swapHtml: swapControl(ctx, lang, date, next),
        extraHtml: degradedNotices(lang, reasons, date),
        hideGenericRationale: reasons.some((r) => r.date === date),
      }),
    )
    .join("\n");
}

/** The degraded reasons for `date` (`null`: the whole week) as inverted notices in household language. */
function degradedNotices(lang: Lang, reasons: DegradedReason[], date: string | null): string {
  return reasons
    .filter((r) => r.date === date)
    .map((r) => notice({ label: t(lang, date === null ? "plan.degraded" : "day.degraded"), text: describeDegraded(lang, r) }))
    .join("\n");
}

/** A one-button form posting the week to `action`; `hidden` adds extra hidden fields. */
function weekForm(weekStart: string, action: string, label: string, hidden: Record<string, string> = {}, buttonClass = ""): string {
  const extra = Object.entries(hidden)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("\n  ");
  return `<form method="post" action="${action}">
  <input type="hidden" name="weekStart" value="${escapeHtml(weekStart)}" />
  ${extra}<button type="submit"${buttonClass ? ` class="${buttonClass}"` : ""}>${escapeHtml(label)}</button>
</form>`;
}

/** FR-9a: a confirmed plan is only replaced after the user says so again. */
function renderConfirmRegenerate(lang: Lang, weekStart: string): string {
  return `<header class="page-head"><h1>${t(lang, "plan.regenerate")}</h1></header>
<p>${t(lang, "plan.confirmedIntro")} <time datetime="${weekStart}">${weekStart}</time>.</p>
${weekForm(weekStart, "/plan/regenerate", t(lang, "plan.replaceConfirmed"), { confirmed_override: "1" })}
<p><a href="/plan?week=${weekStart}">${t(lang, "plan.keepConfirmed")}</a></p>`;
}

const NOTICES = {
  confirmed: "plan.notice.confirmed",
  "plan-confirmed": "plan.notice.plan-confirmed",
  "run-in-progress": "plan.notice.run-in-progress",
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
  language: Lang,
  result: { planId: number; degradedReasons: string[] },
): Promise<void> {
  const sinksPushed = await updateAndPushShoppingList({ ...ctx, log, onProgress, language }, result.planId);
  logPlanSummary(log, ctx.db, result.planId, result.degradedReasons, sinksPushed);
}

export const planRoutes: FeaturePlugin = async (app, ctx) => {
  // Read the ports at run time: `ctx.llm` follows the Settings agent command.
  const ingestDeps = () => ({ db: ctx.db, llm: ctx.llm, fetchPage: ctx.fetchPage, now: ctx.now });

  app.get<{ Querystring: PlanQuery }>("/plan", async (req, reply) => {
    const lang = langOf(req);
    const today = householdToday(ctx.db, ctx.now());
    const weekStart = defaultWeek(ctx.db, req.query.week, today);
    const plan = getPlanForWeek(ctx.db, weekStart);
    const runInFlight = ctx.planRuns.isInFlight(weekStart);
    const message = isNotice(req.query.notice) ? t(lang, NOTICES[req.query.notice]) : undefined;
    const body = `${weekHead(lang, weekStart)}
${weekNav(lang, weekStart, "/plan")}
${message ? notice({ text: message, role: "status" }) : ""}
${plan ? renderPlanTop(ctx.db, lang, weekStart, plan, runInFlight) : renderNoPlanTop(lang, weekStart, runInFlight)}
${planRunBanner(ctx, lang, weekStart)}
${renderDays(ctx, lang, weekStart, today)}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "plan.title"), body, lang, tab: "plan" });
  });

  /**
   * Starts the week's Plan Run without awaiting it and redirects to the Plan page at once; the
   * page's banner follows the run. A week with a run in flight gets a notice and nothing new.
   * A throw leaves the rows written before it: one after Dish selection keeps the new plan.
   */
  const startRun = (req: FastifyRequest, reply: FastifyReply, weekStart: string, trigger: "generate" | "regenerate") => {
    const log = runLogger(ctx.log, req, "plan");
    const language = langOf(req);
    const started = Date.now();
    const launched = launchPlanRun({ planRuns: ctx.planRuns, now: ctx.now, log }, { weekStart, runId: req.id }, async (onProgress) => {
      log.info({ weekStart, trigger }, "run started");
      // Lunch must be stored before planning or the category collision rule (FR-6b) has nothing to check.
      // FR-9 / Q17: regenerate re-checks the school menus (forced ingest) and reports changed entries.
      const { changed } = await ingestWeek({ ...ingestDeps(), log, onProgress }, weekStart, { force: trigger === "regenerate" });
      const result = await generatePlan(
        { db: ctx.db, llm: ctx.llm, now: () => ctx.now().toISOString(), log, onProgress, language },
        weekStart,
        { replace: trigger === "regenerate" },
      );
      logRunFinished(log, weekStart, result, started, { lunchChanged: changed.length });
      if ("planId" in result) await finishPlan(ctx, log, onProgress, language, result); // Shopping List follows the plan (FR-11), then sinks (FR-13)
      return { lunchChanged: trigger === "regenerate" ? changed : [] };
    });
    const notice = launched ? "" : "&notice=run-in-progress";
    return reply.redirect(`/plan?week=${weekStart}${notice}`, 303);
  };

  app.post<{ Body: GenerateForm }>("/plan/generate", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(`/plan?week=${weekStart}&notice=run-in-progress`, 303);
    // FR-9a: generate never replaces a confirmed plan.
    if (getPlanForWeek(ctx.db, weekStart)?.status === "confirmed") return reply.redirect(`/plan?week=${weekStart}&notice=confirmed`, 303);
    return startRun(req, reply, weekStart, "generate");
  });

  // FR-9 / Q17: manual regenerate re-checks the school menus (forced ingest), replaces the
  // week's plan, and reports stored Lunch Entries that changed. No silent re-plan.
  app.post<{ Body: RegenerateForm }>("/plan/regenerate", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(`/plan?week=${weekStart}&notice=run-in-progress`, 303);
    if (getPlanForWeek(ctx.db, weekStart)?.status === "confirmed" && !req.body.confirmed_override) {
      const lang = langOf(req);
      reply.type("text/html; charset=utf-8");
      return page({ title: t(lang, "plan.regenerate"), body: renderConfirmRegenerate(lang, weekStart), lang, tab: "plan" });
    }
    return startRun(req, reply, weekStart, "regenerate");
  });

  // FR-9a: lock the week's plan from automatic changes. Not while a run is in flight: a
  // Regenerate in progress would overwrite the plan the user just confirmed.
  app.post<{ Body: GenerateForm }>("/plan/confirm", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(`/plan?week=${weekStart}&notice=run-in-progress`, 303);
    confirmPlan(ctx.db, weekStart);
    return reply.redirect(`/plan?week=${weekStart}&notice=plan-confirmed`, 303);
  });
};
