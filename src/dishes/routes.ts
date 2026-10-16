import type { FeaturePlugin } from "../app.js";
import { NAV, escapeHtml, page } from "../ui/layout.js";
import { MAIN_CATEGORIES, MAIN_CATEGORY_KEYS, isMainCategory, type MainCategory } from "./categories.js";
import {
  WEEKDAYS,
  createDish,
  deleteDish,
  getDish,
  isWeekday,
  listDishes,
  updateDish,
  type Dish,
  type DishInput,
  type Ingredient,
  type Weekday,
} from "./repo.js";

NAV.push({ href: "/dishes", label: "Dishes" });

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** Raw urlencoded body of the dish form. Checkbox groups arrive as string | string[] | undefined. */
interface DishFormBody {
  name?: string;
  recipe_url?: string;
  adaptation_notes?: string;
  prep_time_minutes?: string;
  main_category?: string;
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
function toDishInput(body: DishFormBody): { input: DishInput } | { error: string } {
  const name = blank(body.name);
  if (!name) return { error: "Name is required." };

  const prepRaw = blank(body.prep_time_minutes);
  const prepTimeMinutes = prepRaw === null ? null : Number(prepRaw);
  if (prepTimeMinutes !== null && (!Number.isInteger(prepTimeMinutes) || prepTimeMinutes < 0)) {
    return { error: "Prep time must be a whole number of minutes." };
  }

  const categoryRaw = blank(body.main_category);
  let mainCategory: MainCategory | null = null;
  if (categoryRaw !== null) {
    if (!isMainCategory(categoryRaw)) return { error: "Main Category must be one of the fixed list." };
    mainCategory = categoryRaw;
  }
  // Hook for FR-1: when no category is chosen, `LlmAgent` may propose one here (not in this ticket).

  const daysRaw = body.preferred_days === undefined ? [] : [body.preferred_days].flat();
  const preferredDays = WEEKDAYS.filter((d) => daysRaw.includes(d));
  if (daysRaw.some((d) => !isWeekday(d))) return { error: "Preferred Days must be weekdays." };

  return {
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
  ingredients: [],
};

function dishForm(action: string, dish: Omit<Dish, "id">, error?: string): string {
  const categoryOptions = [
    `<option value=""${dish.mainCategory === null ? " selected" : ""}>(none)</option>`,
    ...MAIN_CATEGORY_KEYS.map(
      (key) =>
        `<option value="${key}"${dish.mainCategory === key ? " selected" : ""}>${escapeHtml(MAIN_CATEGORIES[key].en)} / ${escapeHtml(MAIN_CATEGORIES[key].sv)}</option>`,
    ),
  ].join("\n        ");
  const dayBoxes = WEEKDAYS.map((d) =>
    checkbox("preferred_days", d, WEEKDAY_LABELS[d], dish.preferredDays.includes(d)),
  ).join("\n        ");
  return `${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      <label>Name <input name="name" required value="${escapeHtml(dish.name)}" /></label>
      <label>Recipe URL <input name="recipe_url" type="url" value="${escapeHtml(dish.recipeUrl ?? "")}" /></label>
      <label>Prep time (minutes) <input name="prep_time_minutes" type="number" min="0" step="1" value="${escapeHtml(dish.prepTimeMinutes ?? "")}" /></label>
      <label>Main Category
        <select name="main_category">
        ${categoryOptions}
        </select>
      </label>
      <label>Adaptation notes <textarea name="adaptation_notes" rows="2">${escapeHtml(dish.adaptationNotes ?? "")}</textarea></label>
      <label>Ingredients (one per line: name | quantity | unit)
        <textarea name="ingredients" rows="6">${escapeHtml(formatIngredientLines(dish.ingredients))}</textarea>
      </label>
      ${checkbox("in_rotation", "1", "In rotation (Favorite Dish, eligible for planning)", dish.inRotation)}
      <fieldset>
        <legend>Preferred Days (soft)</legend>
        ${dayBoxes}
      </fieldset>
      ${checkbox("weekend_only", "1", "Weekend Dish (only Saturday or Sunday)", dish.weekendOnly)}
      <p><button type="submit">Save</button> <a href="/dishes">Cancel</a></p>
    </form>`;
}

function dishListItem(dish: Dish): string {
  const tags = [
    dish.mainCategory ? MAIN_CATEGORIES[dish.mainCategory].en : null,
    dish.prepTimeMinutes !== null ? `${dish.prepTimeMinutes} min` : null,
    dish.inRotation ? null : "not in rotation",
    dish.weekendOnly ? "weekend" : null,
    dish.preferredDays.length ? dish.preferredDays.map((d) => WEEKDAY_LABELS[d]).join("/") : null,
  ].filter((t): t is string => t !== null);
  return `<li>
        <a href="/dishes/${dish.id}/edit">${escapeHtml(dish.name)}</a>${tags.length ? ` <small>(${escapeHtml(tags.join(", "))})</small>` : ""}
        <form method="post" action="/dishes/${dish.id}/delete" style="display:inline"><button type="submit">Delete</button></form>
      </li>`;
}

export const dishRoutes: FeaturePlugin = async (app, { db }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/dishes", async (_req, reply) => {
    html(reply);
    const dishes = listDishes(db);
    const body = `<h1>Dishes</h1>
    <p><a href="/dishes/new">Add dish</a></p>
    ${dishes.length ? `<ul>${dishes.map(dishListItem).join("\n")}</ul>` : "<p>No dishes yet.</p>"}`;
    return page({ title: "Dishes", body });
  });

  app.get("/dishes/new", async (_req, reply) => {
    html(reply);
    return page({ title: "New dish", body: `<h1>New dish</h1>${dishForm("/dishes", NEW_DISH)}` });
  });

  app.post<{ Body: DishFormBody }>("/dishes", async (req, reply) => {
    const parsed = toDishInput(req.body ?? {});
    if ("error" in parsed) {
      html(reply);
      return reply
        .code(400)
        .send(page({ title: "New dish", body: `<h1>New dish</h1>${dishForm("/dishes", NEW_DISH, parsed.error)}` }));
    }
    createDish(db, parsed.input);
    return reply.redirect("/dishes", 303);
  });

  app.get<{ Params: { id: string } }>("/dishes/:id/edit", async (req, reply) => {
    const dish = getDish(db, Number(req.params.id));
    if (!dish) return reply.code(404).send("Dish not found");
    html(reply);
    return page({ title: `Edit ${dish.name}`, body: `<h1>Edit dish</h1>${dishForm(`/dishes/${dish.id}`, dish)}` });
  });

  app.post<{ Params: { id: string }; Body: DishFormBody }>("/dishes/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const parsed = toDishInput(req.body ?? {});
    if ("error" in parsed) {
      const dish = getDish(db, id);
      if (!dish) return reply.code(404).send("Dish not found");
      html(reply);
      return reply
        .code(400)
        .send(page({ title: `Edit ${dish.name}`, body: `<h1>Edit dish</h1>${dishForm(`/dishes/${id}`, dish, parsed.error)}` }));
    }
    if (!updateDish(db, id, parsed.input)) return reply.code(404).send("Dish not found");
    return reply.redirect("/dishes", 303);
  });

  app.post<{ Params: { id: string } }>("/dishes/:id/delete", async (req, reply) => {
    deleteDish(db, Number(req.params.id));
    return reply.redirect("/dishes", 303);
  });
};
