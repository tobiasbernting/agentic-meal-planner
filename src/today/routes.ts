import type { AppContext, FeaturePlugin } from "../app.js";
import { ingestWeek } from "../lunch/ingest.js";
import { runLogger } from "../logging/logger.js";
import { noLunchNotice, type NoLunchNotice } from "../lunch/notice.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { getDish } from "../dishes/repo.js";
import { suggestedBadge } from "../dishes/suggested-badge.js";
import { getPlanForWeek, type PlannedDinner } from "../planner/repo.js";
import { mondayOf } from "../week.js";
import { householdToday } from "../planner/settings.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { escapeHtml, page } from "../ui/layout.js";

function renderSchoolLunch(notice: NoLunchNotice, lang: Lang, date: string, { school, entry }: SchoolLunch): string {
  const body = entry
    ? `<ul>${entry.rawText
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => `<li>${escapeHtml(line.trim())}</li>`)
        .join("")}</ul>`
    : notice(lang, date, school);
  return `<article class="school-lunch"><h3>${escapeHtml(school.name)}</h3>${body}</article>`;
}

/** Today's Planned Dinner from the stored Weekly Plan; `undefined` when the week has no plan. */
function findTodaysDinner(ctx: AppContext, today: string): PlannedDinner | undefined {
  return getPlanForWeek(ctx.db, mondayOf(today))?.dinners.find((d) => d.date === today);
}

function renderDinner(ctx: AppContext, lang: Lang, today: string): string {
  const dinner = findTodaysDinner(ctx, today);
  if (!dinner) return `<p class="notice">${t(lang, "today.noPlan")} <a href="/plan">${t(lang, "today.planThisWeek")}</a></p>`;
  const dish = dinner.dishId === null ? undefined : getDish(ctx.db, dinner.dishId);
  if (!dish) return `<p class="notice">${t(lang, "common.noEligibleDish")}</p>`;
  const name = escapeHtml(dish.name);
  const title = dish.recipeUrl ? `<a href="${escapeHtml(dish.recipeUrl)}">${name}</a>` : name;
  return `<p class="dish">${title}${suggestedBadge(lang, dish)}</p>
  <p class="rationale">${escapeHtml(dinner.rationale)}</p>`;
}

/**
 * Today view (FR-17a): the first screen. Today's Lunch Entry per active School (FR-5 notice
 * when none) and today's Planned Dinner from the stored Weekly Plan.
 */
export const todayRoutes: FeaturePlugin = async (app, ctx) => {
  app.get("/", async (req, reply) => {
    const lang = langOf(req);
    const today = householdToday(ctx.db, ctx.now());
    const lunches = listLunchForDate(ctx.db, today);
    const notice = noLunchNotice(ctx.db);
    const schools =
      lunches.length === 0
        ? `<p>${t(lang, "today.noSchools")} <a href="/schools">${t(lang, "today.addSchool")}</a> ${t(lang, "today.toSeeLunch")}</p>`
        : lunches.map((l) => renderSchoolLunch(notice, lang, today, l)).join("\n");
    const body = `<h1>${t(lang, "app.name")}</h1>
<p><time datetime="${today}">${today}</time></p>
<section id="lunch">
  <h2>${t(lang, "today.schoolLunch")}</h2>
  ${schools}
  <form method="post" action="/lunch/refresh"><button type="submit">${t(lang, "today.refresh")}</button></form>
</section>
<section id="dinner">
  <h2>${t(lang, "common.dinner")}</h2>
  ${renderDinner(ctx, lang, today)}
</section>`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "today.title"), body, lang });
  });

  // Manual lunch refresh (FR-4): ingest the current week for every active School, then back to Today.
  // Scrape failures are recorded as no-data by ingestWeek, so this never fails the request.
  app.post("/lunch/refresh", async (req, reply) => {
    const weekStart = mondayOf(householdToday(ctx.db, ctx.now()));
    const log = runLogger(ctx.log, req, "lunch");
    const started = Date.now();
    log.info({ weekStart, trigger: "refresh" }, "run started");
    const { results, changed } = await ingestWeek({ db: ctx.db, llm: ctx.llm, fetchPage: ctx.fetchPage, now: ctx.now, log }, weekStart, { force: true });
    const statuses = Object.fromEntries(["ok", "cached", "no-data"].map((s) => [s, results.filter((r) => r.status === s).length]));
    log.info({ weekStart, schools: results.length, ...statuses, changed: changed.length, durationMs: Date.now() - started }, "run finished");
    return reply.redirect("/", 303);
  });
};
