import type { FeaturePlugin } from "../app.js";
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

NAV.push({ href: "/schools", label: "Schools" });

interface SchoolForm {
  name?: string;
  url?: string;
}

interface SchoolParams {
  id: string;
}

const INVALID_SCHOOL = "A School needs a name and exactly one menu URL.";

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

function schoolRow(school: School): string {
  const status = school.active ? "" : " <em>(Paused)</em>";
  const toggle = school.active ? action(school, "pause", "Pause") : action(school, "resume", "Resume");
  return `<li>
  <strong>${escapeHtml(school.name)}</strong>${status} &mdash; <a href="${escapeHtml(school.url)}">${escapeHtml(school.url)}</a>
  <a href="/schools/${school.id}/edit">Edit</a> ${toggle} ${action(school, "delete", "Delete")}
</li>`;
}

function schoolFields(school?: SchoolInput): string {
  return `<label>Name <input name="name" required value="${escapeHtml(school?.name ?? "")}" /></label>
  <label>Menu URL <input name="url" type="url" required value="${escapeHtml(school?.url ?? "")}" /></label>`;
}

function notice(error?: string): string {
  return error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
}

function listPage(schools: School[], error?: string): string {
  const body = `<h1>Schools</h1>
${notice(error)}
<ul>
${schools.map(schoolRow).join("\n")}
</ul>
<h2>Add a School</h2>
<form method="post" action="/schools">
  ${schoolFields()}
  <button type="submit">Add</button>
</form>`;
  return page({ title: "Schools", body });
}

function editPage(school: School, error?: string): string {
  const body = `<h1>Edit School</h1>
${notice(error)}
<form method="post" action="/schools/${school.id}">
  ${schoolFields(school)}
  <button type="submit">Save</button>
</form>
<p><a href="/schools">Back to Schools</a></p>`;
  return page({ title: "Edit School", body });
}

export const schoolRoutes: FeaturePlugin = async (app, { db }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/schools", async (_req, reply) => {
    html(reply);
    return listPage(listSchools(db));
  });

  app.post<{ Body: SchoolForm }>("/schools", async (req, reply) => {
    const input = parseSchoolForm(req.body);
    if (!input) {
      html(reply.code(400));
      return listPage(listSchools(db), INVALID_SCHOOL);
    }
    createSchool(db, input);
    return reply.redirect("/schools", 303);
  });

  app.get<{ Params: SchoolParams }>("/schools/:id/edit", async (req, reply) => {
    const school = getSchool(db, Number(req.params.id));
    if (!school) return reply.code(404).send("School not found");
    html(reply);
    return editPage(school);
  });

  app.post<{ Params: SchoolParams; Body: SchoolForm }>("/schools/:id", async (req, reply) => {
    const school = getSchool(db, Number(req.params.id));
    if (!school) return reply.code(404).send("School not found");
    const input = parseSchoolForm(req.body);
    if (!input) {
      html(reply.code(400));
      return editPage(school, INVALID_SCHOOL);
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
