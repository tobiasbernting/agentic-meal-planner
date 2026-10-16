import type { FeaturePlugin } from "../app.js";
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

NAV.push({ href: "/pantry", label: "Pantry" });

interface PantryForm {
  name?: string;
  /** Comma-separated, as typed (FR-12). */
  aliases?: string;
}

interface PantryParams {
  id: string;
}

const INVALID_ITEM = "A Pantry Item needs a name.";

function parsePantryForm(body: PantryForm): PantryItemInput | undefined {
  const name = body.name?.trim() ?? "";
  if (!name) return undefined;
  return { name, aliases: parseAliases(body.aliases ?? "") };
}

function itemRow(item: PantryItem): string {
  const aliases = item.aliases.length ? ` &mdash; <span>${escapeHtml(item.aliases.join(", "))}</span>` : "";
  return `<li>
  <strong>${escapeHtml(item.name)}</strong>${aliases}
  <a href="/pantry/${item.id}/edit">Edit</a>
  <form method="post" action="/pantry/${item.id}/delete" style="display:inline"><button type="submit">Delete</button></form>
</li>`;
}

function itemFields(item?: PantryItemInput): string {
  return `<label>Name <input name="name" required value="${escapeHtml(item?.name ?? "")}" /></label>
  <label>Aliases (comma-separated) <input name="aliases" value="${escapeHtml(item?.aliases.join(", ") ?? "")}" /></label>`;
}

function notice(error?: string): string {
  return error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
}

function listPage(items: PantryItem[], error?: string): string {
  const body = `<h1>Pantry</h1>
${notice(error)}
<ul>
${items.map(itemRow).join("\n")}
</ul>
<h2>Add a Pantry Item</h2>
<form method="post" action="/pantry">
  ${itemFields()}
  <button type="submit">Add</button>
</form>`;
  return page({ title: "Pantry", body });
}

function editPage(item: PantryItem, error?: string): string {
  const body = `<h1>Edit Pantry Item</h1>
${notice(error)}
<form method="post" action="/pantry/${item.id}">
  ${itemFields(item)}
  <button type="submit">Save</button>
</form>
<p><a href="/pantry">Back to Pantry</a></p>`;
  return page({ title: "Edit Pantry Item", body });
}

export const pantryRoutes: FeaturePlugin = async (app, { db }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/pantry", async (_req, reply) => {
    html(reply);
    return listPage(listPantryItems(db));
  });

  app.post<{ Body: PantryForm }>("/pantry", async (req, reply) => {
    const input = parsePantryForm(req.body);
    if (!input) {
      html(reply.code(400));
      return listPage(listPantryItems(db), INVALID_ITEM);
    }
    createPantryItem(db, input);
    return reply.redirect("/pantry", 303);
  });

  app.get<{ Params: PantryParams }>("/pantry/:id/edit", async (req, reply) => {
    const item = getPantryItem(db, Number(req.params.id));
    if (!item) return reply.code(404).send("Pantry Item not found");
    html(reply);
    return editPage(item);
  });

  app.post<{ Params: PantryParams; Body: PantryForm }>("/pantry/:id", async (req, reply) => {
    const item = getPantryItem(db, Number(req.params.id));
    if (!item) return reply.code(404).send("Pantry Item not found");
    const input = parsePantryForm(req.body);
    if (!input) {
      html(reply.code(400));
      return editPage(item, INVALID_ITEM);
    }
    updatePantryItem(db, item.id, input);
    return reply.redirect("/pantry", 303);
  });

  app.post<{ Params: PantryParams }>("/pantry/:id/delete", async (req, reply) => {
    deletePantryItem(db, Number(req.params.id));
    return reply.redirect("/pantry", 303);
  });
};
