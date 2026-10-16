/**
 * Cache of LLM Ingredient extraction from a Recipe URL (FR-10, ADR-0003). The key is
 * url + sha256 of the fetched page + the Dish's Adaptation notes: an Adaptation changes
 * the extracted list, so two Dishes sharing a URL with different Adaptations get
 * separate rows. `adaptation_notes` is '' (never NULL) so the UNIQUE constraint holds.
 * Only successful extractions are cached; a degraded result is retried next time.
 */
export const SCHEMA_INGREDIENTS = `CREATE TABLE IF NOT EXISTS recipe_extraction (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  adaptation_notes TEXT NOT NULL DEFAULT '',
  ingredients_json TEXT NOT NULL,
  extracted_at     TEXT NOT NULL,
  UNIQUE (url, content_hash, adaptation_notes)
);`;
