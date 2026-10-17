import type { FeaturePlugin } from "../app.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { langOf, t, weekdayName, type Lang } from "../i18n/index.js";
import { MAIN_CATEGORY_KEYS, categoryLabel, isMainCategory, type MainCategory } from "./categories.js";
import { clearDishFromUnconfirmedPlans, listPlannedDatesForDish } from "../planner/repo.js";
import {
  WEEKDAYS,
  createDish,
  deleteDish,
  getDish,
  isWeekday,
  listDishes,
  promoteDishToFavorite,
  updateDish,
  type Dish,
  type DishInput,
  type Ingredient,
} from "./repo.js";
import { promoteForm } from "./suggested-badge.js";

/** Raw urlencoded body of the dish form. Checkbox groups arrive as string | string[] | undefined. */
interface DishFormBody {
  name?: string;
  recipe_url?: string;
  adaptation_notes?: string;
  prep_time_minutes?: string;
  main_category?: string;
  /**
   * Set (hidden field, edit form only) when the user has seen the Main Category select, so a
   * blank `main_category` means "no category" on purpose and the agent must not propose one.
   * Absent on the new-Dish form: a blank category there is "undecided" and gets a proposal.
   */
  main_category_touched?: string;
  in_rotation?: string;
  preferred_days?: string | string[];
  weekend_only?: string;
  ingredient_name?: string | string[];
  ingredient_quantity?: string | string[];
  ingredient_unit?: string | string[];
  ingredient_note?: string | string[];
}

/**
 * Ingredient rows arrive as four parallel fields (every row submits all four, so the arrays
 * line up). Rows without a name are dropped; a quantity takes a Swedish decimal comma.
 */
export function parseIngredientRows(body: DishFormBody): Ingredient[] | "quantity" {
  const column = (value: string | string[] | undefined) => (value === undefined ? [] : [value].flat());
  const names = column(body.ingredient_name);
  const quantities = column(body.ingredient_quantity);
  const units = column(body.ingredient_unit);
  const notes = column(body.ingredient_note);
  const out: Ingredient[] = [];
  for (const [i, raw] of names.entries()) {
    const name = raw.trim();
    if (name === "") continue;
    const qty = (quantities[i] ?? "").trim();
    const quantity = qty === "" ? null : Number(qty.replace(",", "."));
    if (quantity !== null && !Number.isFinite(quantity)) return "quantity";
    const ingredient: Ingredient = { name, quantity, unit: blank(units[i]) };
    const note = blank(notes[i]);
    if (note) ingredient.preparationNote = note;
    out.push(ingredient);
  }
  return out;
}

function blank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Maps the submitted form to a DishInput, or returns an error message. */
function toDishInput(lang: Lang, body: DishFormBody): { input: DishInput; proposeCategory: boolean } | { error: string } {
  const name = blank(body.name);
  if (!name) return { error: t(lang, "dishes.error.nameRequired") };

  const prepRaw = blank(body.prep_time_minutes);
  const prepTimeMinutes = prepRaw === null ? null : Number(prepRaw);
  if (prepTimeMinutes !== null && (!Number.isInteger(prepTimeMinutes) || prepTimeMinutes < 0)) {
    return { error: t(lang, "dishes.error.prepTime") };
  }

  const categoryRaw = blank(body.main_category);
  let mainCategory: MainCategory | null = null;
  if (categoryRaw !== null) {
    if (!isMainCategory(categoryRaw)) return { error: t(lang, "dishes.error.category") };
    mainCategory = categoryRaw;
  }

  const daysRaw = body.preferred_days === undefined ? [] : [body.preferred_days].flat();
  const preferredDays = WEEKDAYS.filter((d) => daysRaw.includes(d));
  if (daysRaw.some((d) => !isWeekday(d))) return { error: t(lang, "dishes.error.days") };

  const ingredients = parseIngredientRows(body);
  if (ingredients === "quantity") return { error: t(lang, "dishes.error.quantity") };

  return {
    // FR-1: only an undecided (blank, untouched) category is handed to the agent, see DishFormBody.
    proposeCategory: mainCategory === null && body.main_category_touched !== "1",
    input: {
      name,
      recipeUrl: blank(body.recipe_url),
      adaptationNotes: blank(body.adaptation_notes),
      prepTimeMinutes,
      mainCategory,
      inRotation: body.in_rotation === "1",
      preferredDays,
      weekendOnly: body.weekend_only === "1",
      ingredients,
    },
  };
}

function chip(name: string, value: string, label: string, checked: boolean): string {
  return `<label class="chip"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${checked ? " checked" : ""} /> ${escapeHtml(label)}</label>`;
}

function checkbox(name: string, value: string, label: string, checked: boolean): string {
  return `<label><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${checked ? " checked" : ""} /> ${escapeHtml(label)}</label>`;
}

/** New dishes default to in rotation (FR-1a); the form reflects that before any save. */
const NEW_DISH: Omit<Dish, "id"> = {
  name: "",
  recipeUrl: null,
  adaptationNotes: null,
  prepTimeMinutes: null,
  mainCategory: null,
  inRotation: true,
  preferredDays: [],
  weekendOnly: false,
  suggested: false,
  ingredients: [],
};

function ingredientRow(lang: Lang, ing: Ingredient | undefined): string {
  const field = (name: string, labelKey: Parameters<typeof t>[1], value: string, attrs = "") =>
    `<label>${t(lang, labelKey)} <input name="${name}"${attrs} value="${escapeHtml(value)}" /></label>`;
  return `<li class="ingredient-row">
        ${field("ingredient_name", "dishes.ingredientName", ing?.name ?? "")}
        ${field("ingredient_quantity", "dishes.ingredientQuantity", String(ing?.quantity ?? ""), ' inputmode="decimal"')}
        ${field("ingredient_unit", "dishes.ingredientUnit", ing?.unit ?? "")}
        ${field("ingredient_note", "dishes.ingredientNote", ing?.preparationNote ?? "")}
        <button type="button" class="quiet" hx-on:click="this.closest('li').remove()">${t(lang, "dishes.removeIngredient")}</button>
      </li>`;
}

function dishForm(lang: Lang, action: string, dish: Omit<Dish, "id">, error?: string, deleteId?: number): string {
  const categoryOptions = [
    `<option value=""${dish.mainCategory === null ? " selected" : ""}>${t(lang, "dishes.categoryNone")}</option>`,
    ...MAIN_CATEGORY_KEYS.map(
      (key) =>
        `<option value="${key}"${dish.mainCategory === key ? " selected" : ""}>${escapeHtml(categoryLabel(key, lang))}</option>`,
    ),
  ].join("\n        ");
  const dayBoxes = WEEKDAYS.map((d) =>
    chip("preferred_days", d, weekdayName(lang, d, "short"), dish.preferredDays.includes(d)),
  ).join("\n        ");
  return `${error ? notice({ text: error }) : ""}
    <form method="post" action="${escapeHtml(action)}">
      ${deleteId !== undefined ? '<input type="hidden" name="main_category_touched" value="1" />' : ""}
      <label>${t(lang, "common.name")} <input name="name" required value="${escapeHtml(dish.name)}" /></label>
      <label>${t(lang, "dishes.recipeUrl")} <input name="recipe_url" type="url" value="${escapeHtml(dish.recipeUrl ?? "")}" /></label>
      <label>${t(lang, "dishes.prepTime")} <input name="prep_time_minutes" type="number" min="0" step="1" value="${escapeHtml(dish.prepTimeMinutes ?? "")}" /></label>
      <label>${t(lang, "dishes.mainCategory")}
        <select name="main_category">
        ${categoryOptions}
        </select>
      </label>
      <label>${t(lang, "dishes.adaptation")} <textarea name="adaptation_notes" rows="2">${escapeHtml(dish.adaptationNotes ?? "")}</textarea></label>
      <fieldset>
        <legend>${t(lang, "dishes.ingredients")}</legend>
        <ul class="ingredient-rows" id="ingredient-rows">
        ${dish.ingredients.map((ing) => ingredientRow(lang, ing)).join("\n")}
        </ul>
        <button type="button" hx-get="/dishes/ingredient-row" hx-target="#ingredient-rows" hx-swap="beforeend">${t(lang, "dishes.addIngredient")}</button>
      </fieldset>
      ${checkbox("in_rotation", "1", t(lang, "dishes.inRotation"), dish.inRotation)}
      <fieldset>
        <legend>${t(lang, "dishes.preferredDays")}</legend>
        ${dayBoxes}
      </fieldset>
      ${checkbox("weekend_only", "1", t(lang, "dishes.weekendOnly"), dish.weekendOnly)}
      <p class="actions"><button type="submit" class="primary" data-working-label="${escapeHtml(t(lang, "dishes.saving"))}">${t(lang, "common.save")}</button> <a class="button quiet" href="/dishes">${t(lang, "common.cancel")}</a></p>
    </form>
    ${deleteId === undefined ? "" : `<p class="actions"><a class="button quiet" href="/dishes/${deleteId}/delete">${t(lang, "dishes.deleteDish")}</a></p>`}`;
}

function dishListItem(lang: Lang, dish: Dish, promote: boolean): string {
  const meta = [
    dish.mainCategory ? categoryLabel(dish.mainCategory, lang) : null,
    dish.prepTimeMinutes !== null ? t(lang, "dishes.prepMinutes", { n: dish.prepTimeMinutes }) : null,
  ].filter((m): m is string => m !== null);
  return `<li>
        <a class="row-link" href="/dishes/${dish.id}/edit"><span class="row-label">${escapeHtml(dish.name)}</span>${meta.length ? `<span class="row-status">${escapeHtml(meta.join(" · "))}</span>` : ""}</a>
        ${promote ? promoteForm(lang, dish.id) : ""}
      </li>`;
}

/** The Referer's path and query when it points at this site, so a redirect never leaves it. */
function sameSitePath(referer: string | undefined, host: string | undefined): string | undefined {
  if (!referer || !(referer.startsWith("/") || /^https?:\/\//.test(referer))) return undefined;
  const base = `http://${host ?? "localhost"}`;
  let url: URL;
  try {
    url = new URL(referer, base);
  } catch {
    return undefined;
  }
  if (url.host !== new URL(base).host || url.pathname.startsWith("//")) return undefined;
  return url.pathname + url.search;
}

export const dishRoutes: FeaturePlugin = async (app, ctx) => {
  const { db } = ctx;
  // FR-1: the agent proposes a Main Category on save; a degraded agent leaves it null. `ctx.llm` is read per call (it follows Settings).
  const withProposedCategory = async ({ input, proposeCategory }: { input: DishInput; proposeCategory: boolean }): Promise<DishInput> => {
    if (!proposeCategory) return input;
    const suggestion = await ctx.llm.suggestMainCategory(input.name, [...MAIN_CATEGORY_KEYS]);
    return suggestion.ok && suggestion.value !== null ? { ...input, mainCategory: suggestion.value } : input;
  };

  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/dishes", async (req, reply) => {
    const lang = langOf(req);
    html(reply);
    const dishes = listDishes(db);
    const favorites = dishes.filter((d) => d.inRotation);
    // Förslag holds every Dish outside the rotation: Suggested ones and any a user took out.
    const suggestions = dishes.filter((d) => !d.inRotation);
    const section = (id: string, titleKey: "dishes.favorites" | "dishes.suggestions", emptyKey: "dishes.noFavorites" | "dishes.noSuggestions", list: Dish[], promote: boolean) =>
      `<section id="${id}">
      <h2>${t(lang, titleKey)}</h2>
      ${list.length ? `<ul class="rows">${list.map((d) => dishListItem(lang, d, promote)).join("\n")}</ul>` : `<p>${t(lang, emptyKey)}</p>`}
    </section>`;
    const body = `<div class="page-head"><h1>${t(lang, "dishes.title")}</h1></div>
    <p class="actions"><a class="button primary" href="/dishes/new">${t(lang, "dishes.add")}</a></p>
    ${dishes.length ? "" : `<p>${t(lang, "dishes.none")}</p>`}
    ${section("favorites", "dishes.favorites", "dishes.noFavorites", favorites, false)}
    ${section("suggestions", "dishes.suggestions", "dishes.noSuggestions", suggestions, true)}`;
    return page({ title: t(lang, "dishes.title"), body, lang, tab: "more" });
  });

  app.get("/dishes/ingredient-row", async (req, reply) => {
    html(reply);
    return ingredientRow(langOf(req), undefined);
  });

  app.get("/dishes/new", async (req, reply) => {
    const lang = langOf(req);
    html(reply);
    return page({ title: t(lang, "dishes.new"), body: `<h1>${t(lang, "dishes.new")}</h1>${dishForm(lang, "/dishes", NEW_DISH)}`, lang, tab: "more" });
  });

  app.post<{ Body: DishFormBody }>("/dishes", async (req, reply) => {
    const lang = langOf(req);
    const parsed = toDishInput(lang, req.body ?? {});
    if ("error" in parsed) {
      html(reply);
      return reply
        .code(400)
        .send(page({ title: t(lang, "dishes.new"), body: `<h1>${t(lang, "dishes.new")}</h1>${dishForm(lang, "/dishes", NEW_DISH, parsed.error)}`, lang, tab: "more" }));
    }
    createDish(db, await withProposedCategory(parsed));
    return reply.redirect("/dishes", 303);
  });

  app.get<{ Params: { id: string } }>("/dishes/:id/edit", async (req, reply) => {
    const lang = langOf(req);
    const dish = getDish(db, Number(req.params.id));
    if (!dish) return reply.code(404).send(t(lang, "dishes.notFound"));
    html(reply);
    return page({ title: t(lang, "dishes.editTitle", { name: dish.name }), body: `<h1>${t(lang, "dishes.edit")}</h1>${dishForm(lang, `/dishes/${dish.id}`, dish, undefined, dish.id)}`, lang, tab: "more" });
  });

  app.post<{ Params: { id: string }; Body: DishFormBody }>("/dishes/:id", async (req, reply) => {
    const lang = langOf(req);
    const id = Number(req.params.id);
    const parsed = toDishInput(lang, req.body ?? {});
    if ("error" in parsed) {
      const dish = getDish(db, id);
      if (!dish) return reply.code(404).send(t(lang, "dishes.notFound"));
      html(reply);
      return reply
        .code(400)
        .send(page({ title: t(lang, "dishes.editTitle", { name: dish.name }), body: `<h1>${t(lang, "dishes.edit")}</h1>${dishForm(lang, `/dishes/${id}`, dish, parsed.error, id)}`, lang, tab: "more" }));
    }
    if (!updateDish(db, id, await withProposedCategory(parsed))) return reply.code(404).send(t(lang, "dishes.notFound"));
    return reply.redirect("/dishes", 303);
  });

  app.post<{ Params: { id: string } }>("/dishes/:id/promote", async (req, reply) => {
    if (!promoteDishToFavorite(db, Number(req.params.id))) return reply.code(404).send(t(langOf(req), "dishes.notFound"));
    return reply.redirect(sameSitePath(req.headers.referer, req.headers.host) ?? "/dishes", 303);
  });

  app.get<{ Params: { id: string } }>("/dishes/:id/delete", async (req, reply) => {
    const lang = langOf(req);
    const dish = getDish(db, Number(req.params.id));
    if (!dish) return reply.code(404).send(t(lang, "dishes.notFound"));
    html(reply);
    const dates = listPlannedDatesForDish(db, dish.id);
    const plannedOn = dates.length ? `<p>${t(lang, "dishes.plannedOn", { dates: dates.join(", ") })}</p>\n    ` : "";
    const body = `<div class="page-head"><h1>${t(lang, "dishes.deleteConfirm", { name: dish.name })}</h1></div>
    ${plannedOn}<p>${t(lang, "dishes.deleteWarning")}</p>
    <form method="post" action="/dishes/${dish.id}/delete" class="actions">
      <input type="hidden" name="confirm" value="1" />
      <button type="submit" class="primary">${t(lang, "dishes.deleteYes")}</button>
      <a class="button quiet" href="/dishes/${dish.id}/edit">${t(lang, "common.cancel")}</a>
    </form>`;
    return page({ title: t(lang, "dishes.deleteConfirm", { name: dish.name }), body, lang, tab: "more" });
  });

  // Delete needs the confirm field the confirmation page sends; a bare POST goes back to ask.
  app.post<{ Params: { id: string }; Body: { confirm?: string } | undefined }>("/dishes/:id/delete", async (req, reply) => {
    const id = Number(req.params.id);
    if (req.body?.confirm !== "1") return reply.redirect(`/dishes/${id}/delete`, 303);
    db.transaction(() => {
      clearDishFromUnconfirmedPlans(db, id);
      deleteDish(db, id);
    })();
    return reply.redirect("/dishes", 303);
  });
};
