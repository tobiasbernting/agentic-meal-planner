/**
 * The Plan Run banner fragment for one week (spec #61). Pages embed `planRunBanner`; while a
 * run is in flight the embedded banner polls this route. When the page under the banner is out
 * of date (dinners saved since, or the run ended) the response asks HTMX to reload the page.
 */
import type { AppContext, FeaturePlugin } from "../app.js";
import { langOf, type Lang } from "../i18n/index.js";
import type { LunchChange } from "../lunch/ingest.js";
import { householdToday, readTimezone } from "../planner/settings.js";
import { getSchool } from "../schools/repo.js";
import { mondayOf } from "../week.js";
import { isShownPhase, pageIsStale, renderPlanRunBanner } from "./banner.js";

const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

/** "School date" labels for changed Lunch Entries; unknown Schools are skipped. */
export function describeLunchChanges(ctx: Pick<AppContext, "db">, changes: LunchChange[]): string[] {
  return changes.flatMap(({ schoolId, date }) => {
    const school = getSchool(ctx.db, schoolId);
    return school ? [`${school.name} ${date}`] : [];
  });
}

/** The banner for the week as it stands now, ready to embed in a page. */
export function planRunBanner(ctx: AppContext, lang: Lang, weekStart: string): string {
  return renderPlanRunBanner(lang, weekStart, ctx.planRuns.get(weekStart), {
    timezone: readTimezone(ctx.db),
    describeChanges: (changes) => describeLunchChanges(ctx, changes),
  });
}

export const planRunRoutes: FeaturePlugin = async (app, ctx) => {
  app.get<{ Querystring: { week?: string; shown?: string } }>("/plan-run/banner", async (req, reply) => {
    const raw = req.query.week;
    const weekStart = mondayOf(raw && WEEK_START.test(raw) ? raw : householdToday(ctx.db, ctx.now()));
    const { shown } = req.query;
    if (isShownPhase(shown) && pageIsStale(shown, ctx.planRuns.get(weekStart))) reply.header("HX-Refresh", "true");
    reply.type("text/html; charset=utf-8");
    return planRunBanner(ctx, langOf(req), weekStart);
  });
};
