import type { FeaturePlugin } from "../app.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { listIngestOutcomes, type IngestOutcome } from "../lunch/outcome.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { shortWhen } from "../ui/when.js";
import { ingestWeek } from "../lunch/ingest.js";
import { runLogger } from "../logging/logger.js";
import { householdToday, readTimezone } from "../planner/settings.js";
import { mondayOf } from "../week.js";
import {
  createSchool,
  deleteSchool,
  getSchool,
  listSchools,
  setSchoolActive,
  updateSchool,
  type School,
  type SchoolInput,
} from "./repo.js";

interface SchoolForm {
  name?: string;
  url?: string;
}

interface SchoolParams {
  id: string;
}

/** A School has exactly one menu URL and a name; anything else is rejected. */
function parseSchoolForm(body: SchoolForm): SchoolInput | undefined {
  const name = body.name?.trim() ?? "";
  const url = body.url?.trim() ?? "";
  if (!name || !url) return undefined;
  return { name, url };
}

function action(school: School, verb: string, label: string, cls = "quiet"): string {
  return `<form method="post" action="/schools/${school.id}/${verb}"><button type="submit" class="${cls}">${label}</button></form>`;
}

/** The menu URL's host name; a stored value that is not a URL is shown as typed. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The Ingest Outcome in household terms: "hämtad lör 10:20", or a plain failure line with a
 * retry. A paused School gets no retry: ingest skips it until it is resumed.
 */
function outcomeLine(lang: Lang, school: School, outcome: IngestOutcome | undefined, timeZone: string | undefined): string {
  if (!outcome) return `<p class="row-status">${t(lang, "schools.outcome.none")}</p>`;
  if (outcome.status === "no-data") {
    const retry = school.active ? action(school, "retry", t(lang, "schools.retry"), "") : "";
    return `<p class="row-status">${t(lang, "schools.outcome.failed")}</p>${retry}`;
  }
  return `<p class="row-status">${t(lang, "schools.outcome.when", { when: shortWhen(lang, outcome.recordedAt, timeZone) })}</p>`;
}

function schoolRow(lang: Lang, school: School, outcome: IngestOutcome | undefined, timeZone: string | undefined): string {
  const status = school.active ? "" : ` <em>(${t(lang, "schools.paused")})</em>`;
  const toggle = school.active ? action(school, "pause", t(lang, "schools.pause")) : action(school, "resume", t(lang, "schools.resume"));
  return `<li class="row with-actions">
  <span class="row-label">${escapeHtml(school.name)}${status}</span>
  <span class="row-status">${escapeHtml(hostOf(school.url))}</span>
  ${outcomeLine(lang, school, outcome, timeZone)}
  <div class="row-actions"><a class="button quiet" href="/schools/${school.id}/edit">${t(lang, "common.edit")}</a> ${toggle} ${action(school, "delete", t(lang, "common.delete"))}</div>
</li>`;
}

function schoolFields(lang: Lang, school?: SchoolInput): string {
  return `<label>${t(lang, "common.name")} <input name="name" required value="${escapeHtml(school?.name ?? "")}" /></label>
  <label>${t(lang, "schools.menuUrl")} <input name="url" type="url" required value="${escapeHtml(school?.url ?? "")}" /></label>`;
}

function errorNotice(error?: string): string {
  return error ? notice({ text: error }) : "";
}

const NOTICES = { paused: "schools.notice.paused" } as const;

function queryNotice(lang: Lang, key: string | undefined): string {
  return key !== undefined && Object.hasOwn(NOTICES, key) ? notice({ text: t(lang, NOTICES[key as keyof typeof NOTICES]), role: "status" }) : "";
}

function listPage(lang: Lang, schools: School[], outcomes: IngestOutcome[], timeZone: string | undefined, error?: string, noticeKey?: string): string {
  const bySchool = new Map(outcomes.map((o) => [o.schoolId, o]));
  const body = `<header class="page-head"><h1>${t(lang, "schools.title")}</h1></header>
${queryNotice(lang, noticeKey)}
${errorNotice(error)}
<ul class="rows">
${schools.map((s) => schoolRow(lang, s, bySchool.get(s.id), timeZone)).join("\n")}
</ul>
<h2>${t(lang, "schools.addHeading")}</h2>
<form method="post" action="/schools">
  ${schoolFields(lang)}
  <button type="submit">${t(lang, "common.add")}</button>
</form>`;
  return page({ title: t(lang, "schools.title"), body, lang, tab: "more" });
}

function editPage(lang: Lang, school: School, error?: string): string {
  const body = `<header class="page-head"><h1>${t(lang, "schools.editHeading")}</h1></header>
${errorNotice(error)}
<form method="post" action="/schools/${school.id}">
  ${schoolFields(lang, school)}
  <button type="submit">${t(lang, "common.save")}</button>
</form>
<p><a href="/schools">${t(lang, "schools.back")}</a></p>`;
  return page({ title: t(lang, "schools.editTitle"), body, lang, tab: "more" });
}

export const schoolRoutes: FeaturePlugin = async (app, ctx) => {
  const { db } = ctx;
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get<{ Querystring: { notice?: string } }>("/schools", async (req, reply) => {
    html(reply);
    return listPage(langOf(req), listSchools(db), listIngestOutcomes(db), readTimezone(db), undefined, req.query.notice);
  });

  app.post<{ Body: SchoolForm }>("/schools", async (req, reply) => {
    const input = parseSchoolForm(req.body);
    if (!input) {
      html(reply.code(400));
      return listPage(langOf(req), listSchools(db), listIngestOutcomes(db), readTimezone(db), t(langOf(req), "schools.invalid"));
    }
    createSchool(db, input);
    return reply.redirect("/schools", 303);
  });

  app.get<{ Params: SchoolParams }>("/schools/:id/edit", async (req, reply) => {
    const school = getSchool(db, Number(req.params.id));
    if (!school) return reply.code(404).send(t(langOf(req), "schools.notFound"));
    html(reply);
    return editPage(langOf(req), school);
  });

  app.post<{ Params: SchoolParams; Body: SchoolForm }>("/schools/:id", async (req, reply) => {
    const school = getSchool(db, Number(req.params.id));
    if (!school) return reply.code(404).send(t(langOf(req), "schools.notFound"));
    const input = parseSchoolForm(req.body);
    if (!input) {
      html(reply.code(400));
      return editPage(langOf(req), school, t(langOf(req), "schools.invalid"));
    }
    updateSchool(db, school.id, input);
    return reply.redirect("/schools", 303);
  });

  // Retry (FR-4): re-ingest this School for the current week, then back to the list. A failed
  // scrape is recorded as no-data by ingestWeek, so this never fails the request. Ingest skips
  // a paused School, so its retry is refused with a notice rather than doing nothing.
  app.post<{ Params: SchoolParams }>("/schools/:id/retry", async (req, reply) => {
    const school = getSchool(db, Number(req.params.id));
    if (!school) return reply.code(404).send(t(langOf(req), "schools.notFound"));
    if (!school.active) return reply.redirect("/schools?notice=paused", 303);
    const weekStart = mondayOf(householdToday(db, ctx.now()));
    const log = runLogger(ctx.log, req, "lunch");
    log.info({ weekStart, schoolId: school.id, trigger: "retry" }, "run started");
    await ingestWeek({ db, llm: ctx.llm, fetchPage: ctx.fetchPage, now: ctx.now, log }, weekStart, { force: true, schoolId: school.id });
    return reply.redirect("/schools", 303);
  });

  app.post<{ Params: SchoolParams }>("/schools/:id/pause", async (req, reply) => {
    setSchoolActive(db, Number(req.params.id), false);
    return reply.redirect("/schools", 303);
  });

  app.post<{ Params: SchoolParams }>("/schools/:id/resume", async (req, reply) => {
    setSchoolActive(db, Number(req.params.id), true);
    return reply.redirect("/schools", 303);
  });

  app.post<{ Params: SchoolParams }>("/schools/:id/delete", async (req, reply) => {
    deleteSchool(db, Number(req.params.id));
    return reply.redirect("/schools", 303);
  });
};
