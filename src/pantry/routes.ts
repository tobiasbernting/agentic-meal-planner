import type { FeaturePlugin } from "../app.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";
import {
  createPantryItem,
  deletePantryItem,
  getPantryItem,
  listPantryItems,
  parseAliases,
  updatePantryItem,
  type PantryItem,
  type PantryItemInput,
} from "./repo.js";

NAV.push({ href: "/pantry", label: "nav.pantry" });

interface PantryForm {
  name?: string;
  /** Comma-separated, as typed (FR-12). */
  aliases?: string;
}

interface PantryParams {
  id: string;
}

function parsePantryForm(body: PantryForm): PantryItemInput | undefined {
  const name = body.name?.trim() ?? "";
  if (!name) return undefined;
  return { name, aliases: parseAliases(body.aliases ?? "") };
}

function itemRow(lang: Lang, item: PantryItem): string {
  const aliases = item.aliases.length ? ` &mdash; <span>${escapeHtml(item.aliases.join(", "))}</span>` : "";
  return `<li>
  <strong>${escapeHtml(item.name)}</strong>${aliases}
  <a href="/pantry/${item.id}/edit">${t(lang, "common.edit")}</a>
  <form method="post" action="/pantry/${item.id}/delete" style="display:inline"><button type="submit">${t(lang, "common.delete")}</button></form>
</li>`;
}

function itemFields(lang: Lang, item?: PantryItemInput): string {
  return `<label>${t(lang, "common.name")} <input name="name" required value="${escapeHtml(item?.name ?? "")}" /></label>
  <label>${t(lang, "pantry.aliases")} <input name="aliases" value="${escapeHtml(item?.aliases.join(", ") ?? "")}" /></label>`;
}

function notice(error?: string): string {
  return error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
}

function listPage(lang: Lang, items: PantryItem[], error?: string): string {
  const body = `<h1>${t(lang, "pantry.title")}</h1>
${notice(error)}
<ul>
${items.map((i) => itemRow(lang, i)).join("\n")}
</ul>
<h2>${t(lang, "pantry.addHeading")}</h2>
<form method="post" action="/pantry">
  ${itemFields(lang)}
  <button type="submit">${t(lang, "common.add")}</button>
</form>`;
  return page({ title: t(lang, "pantry.title"), body, lang });
}

function editPage(lang: Lang, item: PantryItem, error?: string): string {
  const body = `<h1>${t(lang, "pantry.editHeading")}</h1>
${notice(error)}
<form method="post" action="/pantry/${item.id}">
  ${itemFields(lang, item)}
  <button type="submit">${t(lang, "common.save")}</button>
</form>
<p><a href="/pantry">${t(lang, "pantry.back")}</a></p>`;
  return page({ title: t(lang, "pantry.editHeading"), body, lang });
}

export const pantryRoutes: FeaturePlugin = async (app, { db }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/pantry", async (req, reply) => {
    html(reply);
    return listPage(langOf(req), listPantryItems(db));
  });

  app.post<{ Body: PantryForm }>("/pantry", async (req, reply) => {
    const input = parsePantryForm(req.body);
    if (!input) {
      html(reply.code(400));
      return listPage(langOf(req), listPantryItems(db), t(langOf(req), "pantry.invalid"));
    }
    createPantryItem(db, input);
    return reply.redirect("/pantry", 303);
  });

  app.get<{ Params: PantryParams }>("/pantry/:id/edit", async (req, reply) => {
    const item = getPantryItem(db, Number(req.params.id));
    if (!item) return reply.code(404).send(t(langOf(req), "pantry.notFound"));
    html(reply);
    return editPage(langOf(req), item);
  });

  app.post<{ Params: PantryParams; Body: PantryForm }>("/pantry/:id", async (req, reply) => {
    const item = getPantryItem(db, Number(req.params.id));
    if (!item) return reply.code(404).send(t(langOf(req), "pantry.notFound"));
    const input = parsePantryForm(req.body);
    if (!input) {
      html(reply.code(400));
      return editPage(langOf(req), item, t(langOf(req), "pantry.invalid"));
    }
    updatePantryItem(db, item.id, input);
    return reply.redirect("/pantry", 303);
  });

  app.post<{ Params: PantryParams }>("/pantry/:id/delete", async (req, reply) => {
    deletePantryItem(db, Number(req.params.id));
    return reply.redirect("/pantry", 303);
  });
};
