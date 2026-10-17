import type Database from "better-sqlite3";
import type { AppContext, FeaturePlugin } from "../app.js";
import { almanac } from "../almanac/day.js";
import { swapControl } from "../swap/routes.js";
import { ingestWeek } from "../lunch/ingest.js";
import { runLogger } from "../logging/logger.js";
import { listDishes } from "../dishes/repo.js";
import { listSchools } from "../schools/repo.js";
import { addDays, mondayOf, weekDates } from "../week.js";
import { householdToday } from "../planner/settings.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { weekHead, type DayDensity } from "../ui/almanac.js";
import { escapeHtml, page } from "../ui/layout.js";

/** First visit: one block linking to whatever is missing (a School, Dishes). Empty once both exist. */
function firstRun(db: Database.Database, lang: Lang): string {
  const noSchools = listSchools(db).length === 0;
  const noDishes = listDishes(db).length === 0;
  if (!noSchools && !noDishes) return "";
  const links = [
    noSchools ? `<a class="button primary" href="/schools">${t(lang, "today.addSchool")}</a>` : "",
    noDishes ? `<a class="button${noSchools ? "" : " primary"}" href="/dishes/new">${t(lang, "today.addDishes")}</a>` : "",
  ].join("");
  return `<section id="first-run" class="first-run">
  <h2>${t(lang, "today.firstRun.title")}</h2>
  <p>${t(lang, "today.firstRun.text")}</p>
  <div class="actions">${links}</div>
</section>`;
}

/**
 * Today (FR-17a) as an almanac page: the ISO week landmark, then the week Monday to Sunday as
 * almanac day rows. Today's row is open in full, tomorrow half-open, the rest compact. On a
 * Sunday, tomorrow (next Monday) follows the week. "Uppdatera lunchmenyer" sits quietly below.
 */
export const todayRoutes: FeaturePlugin = async (app, ctx) => {
  app.get("/", async (req, reply) => {
    const lang = langOf(req);
    const today = householdToday(ctx.db, ctx.now());
    const tomorrow = addDays(today, 1);
    const dates = weekDates(mondayOf(today));
    if (!dates.includes(tomorrow)) dates.push(tomorrow);
    const density = (date: string): DayDensity => (date === today ? "full" : date === tomorrow ? "half" : "compact");
    const days = almanac(ctx.db, lang);
    const noPlanHtml = `<p>${t(lang, "today.noPlan")} <a href="/plan">${t(lang, "today.planThisWeek")}</a></p>`;
    const rows = dates
      .map((date) =>
        days.day({
          date,
          density: density(date),
          today: date === today,
          noPlanHtml,
          swapHtml: date === today ? swapControl(ctx, lang, date, "/") : undefined,
        }),
      )
      .join("\n");
    const refresh =
      listSchools(ctx.db).length > 0
        ? `<form method="post" action="/lunch/refresh"><button type="submit" class="quiet" data-working-label="${escapeHtml(t(lang, "today.refreshing"))}">${t(lang, "today.refresh")}</button></form>`
        : "";
    const body = `${weekHead(lang, today)}
${firstRun(ctx.db, lang)}
${rows}
${refresh}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "today.title"), body, lang, tab: "today" });
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
