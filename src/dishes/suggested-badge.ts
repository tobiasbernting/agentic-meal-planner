import { t, type Lang } from "../i18n/index.js";
import { escapeHtml } from "../ui/layout.js";
import type { Dish } from "./repo.js";

/** The "Add to favorites" button that promotes a Suggested Dish (POST /dishes/:id/promote). */
export function promoteForm(lang: Lang, dishId: number, inline = false): string {
  return `<form method="post" action="/dishes/${dishId}/promote" hx-post="/dishes/${dishId}/promote" hx-target="this" hx-swap="outerHTML"${inline ? ' style="display:inline"' : ""}><button type="submit" data-working-label="${escapeHtml(t(lang, "dishes.addingToFavorites"))}">${t(lang, "dishes.addToFavorites")}</button></form>`;
}

/** The "Suggested" badge plus promote form for a Suggested Dish; empty for any other Dish. */
export function suggestedBadge(lang: Lang, dish: Pick<Dish, "id" | "suggested"> | undefined): string {
  if (!dish?.suggested) return "";
  return ` <span class="tag-suggested">${t(lang, "dishes.tagSuggested")}</span>
${promoteForm(lang, dish.id)}`;
}
