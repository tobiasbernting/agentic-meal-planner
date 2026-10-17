/**
 * Cache of LLM Ingredient extraction from a Recipe URL (FR-10, ADR-0003). The key is
 * url + sha256 of the fetched page + the Dish's Adaptation notes + the UI language: an
 * Adaptation changes the extracted list, so two Dishes sharing a URL with different
 * Adaptations get separate rows, and Ingredients are named in the household's language,
 * so a language change extracts again. `adaptation_notes` is '' (never NULL) so the UNIQUE constraint holds.
 * Only successful extractions are cached; a degraded result is retried next time.
 *
 * `found_recipe` (#30, FR-2) caches the LLM-found recipe for a Dish with neither manual
 * Ingredients nor a Recipe URL, keyed by Dish name + Adaptation notes + language, so repeated weeks
 * do not search the web again. There is no page content to hash: the agent returns the
 * url and the list in one call. Same rule: only successes are cached.
 */
export const SCHEMA_INGREDIENTS = `CREATE TABLE IF NOT EXISTS recipe_extraction (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  adaptation_notes TEXT NOT NULL DEFAULT '',
  language         TEXT NOT NULL,
  ingredients_json TEXT NOT NULL,
  extracted_at     TEXT NOT NULL,
  UNIQUE (url, content_hash, adaptation_notes, language)
);
CREATE TABLE IF NOT EXISTS found_recipe (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_name        TEXT NOT NULL,
  adaptation_notes TEXT NOT NULL DEFAULT '',
  language         TEXT NOT NULL,
  url              TEXT NOT NULL,
  ingredients_json TEXT NOT NULL,
  found_at         TEXT NOT NULL,
  UNIQUE (dish_name, adaptation_notes, language)
);`;
