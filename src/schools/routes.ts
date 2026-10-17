import type { FeaturePlugin } from "../app.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { listIngestOutcomes, type IngestOutcome } from "../lunch/outcome.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";
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

NAV.push({ href: "/schools", label: "nav.schools" });

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

function action(school: School, verb: string, label: string): string {
  return `<form method="post" action="/schools/${school.id}/${verb}" style="display:inline"><button type="submit">${label}</button></form>`;
}

function outcomeLine(lang: Lang, outcome: IngestOutcome | undefined): string {
  if (!outcome) return `<p class="ingest-outcome">${t(lang, "schools.outcome.none")}</p>`;
  const reason = outcome.reason ? `: ${escapeHtml(outcome.reason)}` : "";
  const at = escapeHtml(outcome.recordedAt);
  return `<p class="ingest-outcome">${t(lang, `schools.outcome.${outcome.status}`)}${reason} <time datetime="${at}">${at}</time></p>`;
}

function schoolRow(lang: Lang, school: School, outcome?: IngestOutcome): string {
  const status = school.active ? "" : ` <em>(${t(lang, "schools.paused")})</em>`;
  const toggle = school.active ? action(school, "pause", t(lang, "schools.pause")) : action(school, "resume", t(lang, "schools.resume"));
  return `<li>
  <strong>${escapeHtml(school.name)}</strong>${status} &mdash; <a href="${escapeHtml(school.url)}">${escapeHtml(school.url)}</a>
  <a href="/schools/${school.id}/edit">${t(lang, "common.edit")}</a> ${toggle} ${action(school, "delete", t(lang, "common.delete"))}
  ${outcomeLine(lang, outcome)}
</li>`;
}

function schoolFields(lang: Lang, school?: SchoolInput): string {
  return `<label>${t(lang, "common.name")} <input name="name" required value="${escapeHtml(school?.name ?? "")}" /></label>
  <label>${t(lang, "schools.menuUrl")} <input name="url" type="url" required value="${escapeHtml(school?.url ?? "")}" /></label>`;
}

function notice(error?: string): string {
  return error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
}

function listPage(lang: Lang, schools: School[], outcomes: IngestOutcome[], error?: string): string {
  const bySchool = new Map(outcomes.map((o) => [o.schoolId, o]));
  const body = `<h1>${t(lang, "schools.title")}</h1>
${notice(error)}
<ul>
${schools.map((s) => schoolRow(lang, s, bySchool.get(s.id))).join("\n")}
</ul>
<h2>${t(lang, "schools.addHeading")}</h2>
<form method="post" action="/schools">
  ${schoolFields(lang)}
  <button type="submit">${t(lang, "common.add")}</button>
</form>`;
  return page({ title: t(lang, "schools.title"), body, lang });
}

function editPage(lang: Lang, school: School, error?: string): string {
  const body = `<h1>${t(lang, "schools.editHeading")}</h1>
${notice(error)}
<form method="post" action="/schools/${school.id}">
  ${schoolFields(lang, school)}
  <button type="submit">${t(lang, "common.save")}</button>
</form>
<p><a href="/schools">${t(lang, "schools.back")}</a></p>`;
  return page({ title: t(lang, "schools.editTitle"), body, lang });
}

export const schoolRoutes: FeaturePlugin = async (app, { db }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/schools", async (req, reply) => {
    html(reply);
    return listPage(langOf(req), listSchools(db), listIngestOutcomes(db));
  });

  app.post<{ Body: SchoolForm }>("/schools", async (req, reply) => {
    const input = parseSchoolForm(req.body);
    if (!input) {
      html(reply.code(400));
      return listPage(langOf(req), listSchools(db), listIngestOutcomes(db), t(langOf(req), "schools.invalid"));
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
