import type { FeaturePlugin } from "../app.js";
import { NAV, escapeHtml, page } from "../ui/layout.js";
import { langOf, t, weekdayName, type Lang } from "../i18n/index.js";
import { MAIN_CATEGORY_KEYS, categoryLabel, isMainCategory, type MainCategory } from "./categories.js";
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

NAV.push({ href: "/dishes", label: "nav.dishes" });

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
  ingredients?: string;
}

/**
 * Manual Ingredients are edited as one line per Ingredient: `name | quantity | unit`.
 * Quantity and unit are optional; a quantity that is not a number is kept as part of the unit
 * rather than silently dropped (e.g. "salt | a pinch" -> unit "a pinch").
 */
export function parseIngredientLines(text: string): Ingredient[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", qty = "", unit = ""] = line.split("|").map((part) => part.trim());
      const quantity = qty === "" ? null : Number(qty.replace(",", "."));
      if (quantity !== null && !Number.isFinite(quantity)) {
        return { name, quantity: null, unit: [qty, unit].filter(Boolean).join(" ") || null };
      }
      return { name, quantity, unit: unit || null };
    })
    .filter((ing) => ing.name !== "");
}

export function formatIngredientLines(ingredients: Ingredient[]): string {
  return ingredients
    .map((ing) => {
      const parts = [ing.name, ing.quantity ?? "", ing.unit ?? ""];
      while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
      return parts.join(" | ");
    })
    .join("\n");
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
      ingredients: parseIngredientLines(body.ingredients ?? ""),
    },
  };
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

function dishForm(lang: Lang, action: string, dish: Omit<Dish, "id">, error?: string, editing = false): string {
  const categoryOptions = [
    `<option value=""${dish.mainCategory === null ? " selected" : ""}>${t(lang, "dishes.categoryNone")}</option>`,
    ...MAIN_CATEGORY_KEYS.map(
      (key) =>
        `<option value="${key}"${dish.mainCategory === key ? " selected" : ""}>${escapeHtml(categoryLabel(key, lang))}</option>`,
    ),
  ].join("\n        ");
  const dayBoxes = WEEKDAYS.map((d) =>
    checkbox("preferred_days", d, weekdayName(lang, d, "short"), dish.preferredDays.includes(d)),
  ).join("\n        ");
  return `${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      ${editing ? '<input type="hidden" name="main_category_touched" value="1" />' : ""}
      <label>${t(lang, "common.name")} <input name="name" required value="${escapeHtml(dish.name)}" /></label>
      <label>${t(lang, "dishes.recipeUrl")} <input name="recipe_url" type="url" value="${escapeHtml(dish.recipeUrl ?? "")}" /></label>
      <label>${t(lang, "dishes.prepTime")} <input name="prep_time_minutes" type="number" min="0" step="1" value="${escapeHtml(dish.prepTimeMinutes ?? "")}" /></label>
      <label>${t(lang, "dishes.mainCategory")}
        <select name="main_category">
        ${categoryOptions}
        </select>
      </label>
      <label>${t(lang, "dishes.adaptation")} <textarea name="adaptation_notes" rows="2">${escapeHtml(dish.adaptationNotes ?? "")}</textarea></label>
      <label>${t(lang, "dishes.ingredients")}
        <textarea name="ingredients" rows="6">${escapeHtml(formatIngredientLines(dish.ingredients))}</textarea>
      </label>
      ${checkbox("in_rotation", "1", t(lang, "dishes.inRotation"), dish.inRotation)}
      <fieldset>
        <legend>${t(lang, "dishes.preferredDays")}</legend>
        ${dayBoxes}
      </fieldset>
      ${checkbox("weekend_only", "1", t(lang, "dishes.weekendOnly"), dish.weekendOnly)}
      <p><button type="submit">${t(lang, "common.save")}</button> <a href="/dishes">${t(lang, "common.cancel")}</a></p>
    </form>`;
}

function dishListItem(lang: Lang, dish: Dish): string {
  const tags = [
    dish.mainCategory ? categoryLabel(dish.mainCategory, lang) : null,
    dish.prepTimeMinutes !== null ? t(lang, "dishes.prepMinutes", { n: dish.prepTimeMinutes }) : null,
    dish.suggested ? t(lang, "dishes.tagSuggested") : null,
    dish.inRotation ? null : t(lang, "dishes.tagNotInRotation"),
    dish.weekendOnly ? t(lang, "dishes.tagWeekend") : null,
    dish.preferredDays.length ? dish.preferredDays.map((d) => weekdayName(lang, d, "short")).join("/") : null,
  ].filter((t): t is string => t !== null);
  return `<li>
        <a href="/dishes/${dish.id}/edit">${escapeHtml(dish.name)}</a>${tags.length ? ` <small>(${escapeHtml(tags.join(", "))})</small>` : ""}
        ${dish.suggested ? promoteForm(lang, dish.id, true) : ""}
        <form method="post" action="/dishes/${dish.id}/delete" style="display:inline"><button type="submit">${t(lang, "common.delete")}</button></form>
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
    const body = `<h1>${t(lang, "dishes.title")}</h1>
    <p><a href="/dishes/new">${t(lang, "dishes.add")}</a></p>
    ${dishes.length ? `<ul>${dishes.map((d) => dishListItem(lang, d)).join("\n")}</ul>` : `<p>${t(lang, "dishes.none")}</p>`}`;
    return page({ title: t(lang, "dishes.title"), body, lang });
  });

  app.get("/dishes/new", async (req, reply) => {
    const lang = langOf(req);
    html(reply);
    return page({ title: t(lang, "dishes.new"), body: `<h1>${t(lang, "dishes.new")}</h1>${dishForm(lang, "/dishes", NEW_DISH)}`, lang });
  });

  app.post<{ Body: DishFormBody }>("/dishes", async (req, reply) => {
    const lang = langOf(req);
    const parsed = toDishInput(lang, req.body ?? {});
    if ("error" in parsed) {
      html(reply);
      return reply
        .code(400)
        .send(page({ title: t(lang, "dishes.new"), body: `<h1>${t(lang, "dishes.new")}</h1>${dishForm(lang, "/dishes", NEW_DISH, parsed.error)}`, lang }));
    }
    createDish(db, await withProposedCategory(parsed));
    return reply.redirect("/dishes", 303);
  });

  app.get<{ Params: { id: string } }>("/dishes/:id/edit", async (req, reply) => {
    const lang = langOf(req);
    const dish = getDish(db, Number(req.params.id));
    if (!dish) return reply.code(404).send(t(lang, "dishes.notFound"));
    html(reply);
    return page({ title: t(lang, "dishes.editTitle", { name: dish.name }), body: `<h1>${t(lang, "dishes.edit")}</h1>${dishForm(lang, `/dishes/${dish.id}`, dish, undefined, true)}`, lang });
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
        .send(page({ title: t(lang, "dishes.editTitle", { name: dish.name }), body: `<h1>${t(lang, "dishes.edit")}</h1>${dishForm(lang, `/dishes/${id}`, dish, parsed.error, true)}`, lang }));
    }
    if (!updateDish(db, id, await withProposedCategory(parsed))) return reply.code(404).send(t(lang, "dishes.notFound"));
    return reply.redirect("/dishes", 303);
  });

  app.post<{ Params: { id: string } }>("/dishes/:id/promote", async (req, reply) => {
    if (!promoteDishToFavorite(db, Number(req.params.id))) return reply.code(404).send(t(langOf(req), "dishes.notFound"));
    return reply.redirect(sameSitePath(req.headers.referer, req.headers.host) ?? "/dishes", 303);
  });

  app.post<{ Params: { id: string } }>("/dishes/:id/delete", async (req, reply) => {
    deleteDish(db, Number(req.params.id));
    return reply.redirect("/dishes", 303);
  });
};
