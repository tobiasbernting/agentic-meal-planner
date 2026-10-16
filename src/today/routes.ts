import type { FeaturePlugin } from "../app.js";
import { ingestWeek } from "../lunch/ingest.js";
import { listLunchForDate, type SchoolLunch } from "../lunch/repo.js";
import { addDays } from "../lunch/week.js";
import { escapeHtml, page } from "../ui/layout.js";

/** Local calendar date `YYYY-MM-DD` of `d` (the household's clock, not UTC). */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderSchoolLunch({ school, entry }: SchoolLunch): string {
  const body = entry
    ? `<ul>${entry.rawText
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => `<li>${escapeHtml(line.trim())}</li>`)
        .join("")}</ul>`
    : `<p class="notice">No lunch data</p>`;
  return `<article class="school-lunch"><h3>${escapeHtml(school.name)}</h3>${body}</article>`;
}

/**
 * Today view (FR-17a): the first screen. Today's Lunch Entry per active School (FR-5 notice
 * when none) and today's Planned Dinner (placeholder until the planner ships).
 */
export const todayRoutes: FeaturePlugin = async (app, ctx) => {
  app.get("/", async (_req, reply) => {
    const today = localDate(ctx.now());
    const lunches = listLunchForDate(ctx.db, today);
    const schools =
      lunches.length === 0
        ? `<p>No Schools yet. <a href="/schools">Add a School</a> to see today's lunch.</p>`
        : lunches.map(renderSchoolLunch).join("\n");
    const body = `<h1>Meal Planner</h1>
<p><time datetime="${today}">${today}</time></p>
<section id="lunch">
  <h2>School lunch</h2>
  ${schools}
  <form method="post" action="/lunch/refresh"><button type="submit">Refresh lunch menus</button></form>
</section>
<section id="dinner">
  <h2>Dinner</h2>
  <p>No plan yet</p>
</section>`;
    reply.type("text/html; charset=utf-8");
    return page({ title: "Today", body });
  });

  // Manual lunch refresh (FR-4): ingest the current week for every active School, then back to Today.
  // Scrape failures are recorded as no-data by ingestWeek, so this never fails the request.
  app.post("/lunch/refresh", async (_req, reply) => {
    await ingestWeek(ctx, mondayOf(localDate(ctx.now())), { force: true });
    return reply.redirect("/", 303);
  });
};

/** The Monday `YYYY-MM-DD` of the week containing `date`. */
export function mondayOf(date: string): string {
  const offset = (weekdayIndex(date) + 6) % 7; // Mon=0 .. Sun=6
  return addDays(date, -offset);
}

function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
