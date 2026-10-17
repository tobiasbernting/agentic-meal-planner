import { createHash } from "node:crypto";
import { silentLogger, type Logger } from "../logging/logger.js";
import type Database from "better-sqlite3";
import { getDish, type Dish, type Ingredient } from "../dishes/repo.js";
import type { Ingredient as LlmIngredient, LlmAgent } from "../llm/index.js";
import { listPlannedDinners, setPlannedDinnerSource, type PlannedDinner } from "../planner/repo.js";
import type { FetchPage } from "../plugins/schools/index.js";

export interface ResolveDeps {
  db: Database.Database;
  llm: LlmAgent;
  fetchPage: FetchPage;
  /** Timestamp for cache rows (ISO string); defaults to the wall clock. */
  now?: () => Date;
  /** Run logger (bound to `runId`); defaults to `silentLogger`. */
  log?: Logger;
}

export type IngredientSource = "manual" | "url" | "llm" | "none";

export interface ResolvedIngredients {
  ingredients: Ingredient[];
  source: IngredientSource;
  /** The Recipe URL the list came from (`source: "url"`) or the LLM-found recipe's link (`source: "llm"`). */
  sourceUrl?: string;
  /** Set when the list is empty because extraction was unavailable (fetch or agent failure). */
  degradedReason?: string;
}

/**
 * Resolves a Dish's Ingredients by precedence (FR-10, ADR-0003):
 *
 * 1. Manual Ingredients (`dish_ingredient`) win whenever present. They are what the
 *    household actually cooks, so Adaptation notes are NOT applied to them.
 * 2. Otherwise the Recipe URL: the page is fetched, hashed (sha256), and the LLM
 *    extraction is cached per url + content hash + Adaptation notes. Fetching is cheap
 *    and happens on every resolve (it is how we learn the hash); the expensive LLM call
 *    runs once per distinct page content. Adaptations are applied during extraction.
 * 3. Neither: the LLM finds a recipe from the Dish name (`llm.findRecipe`, FR-2) and
 *    extracts from it, Adaptations applied; the result is cached per name + Adaptation
 *    (`found_recipe`) and carries `sourceUrl` for the Planned Dinner's link. When the
 *    agent cannot find one: `source: "none"` with an empty list and `degradedReason`.
 *
 * Never throws for fetch or agent failure: the result degrades with `degradedReason`.
 */
export async function resolveIngredients(deps: ResolveDeps, dish: Dish): Promise<ResolvedIngredients> {
  const resolved = await resolveByPrecedence(deps, dish);
  if (resolved.degradedReason) {
    (deps.log ?? silentLogger)
      .child({ component: "ingredients" })
      .warn({ dishId: dish.id, dish: dish.name, source: resolved.source, reason: resolved.degradedReason }, "ingredient resolution degraded");
  }
  return resolved;
}

async function resolveByPrecedence(deps: ResolveDeps, dish: Dish): Promise<ResolvedIngredients> {
  if (dish.ingredients.length > 0) return { ingredients: dish.ingredients, source: "manual" };
  if (dish.recipeUrl) return resolveFromUrl(deps, dish.recipeUrl, dish.adaptationNotes ?? "");
  return resolveFromLlm(deps, dish.name, dish.adaptationNotes ?? "");
}

async function resolveFromLlm(deps: ResolveDeps, dishName: string, adaptationNotes: string): Promise<ResolvedIngredients> {
  const cached = readFoundRecipe(deps.db, dishName, adaptationNotes);
  if (cached) return { ingredients: cached.ingredients, source: "llm", sourceUrl: cached.url };

  const result = await deps.llm.findRecipe(dishName, { adaptationNotes: adaptationNotes || undefined });
  if (!result.ok) return { ingredients: [], source: "none", degradedReason: result.reason };
  const ingredients = result.value.ingredients.map(toIngredient);
  writeFoundRecipe(deps.db, dishName, adaptationNotes, result.value.url, ingredients, (deps.now?.() ?? new Date()).toISOString());
  return { ingredients, source: "llm", sourceUrl: result.value.url };
}

function readFoundRecipe(
  db: Database.Database,
  dishName: string,
  adaptationNotes: string,
): { url: string; ingredients: Ingredient[] } | undefined {
  const row = db
    .prepare("SELECT url, ingredients_json FROM found_recipe WHERE dish_name = ? AND adaptation_notes = ?")
    .get(dishName, adaptationNotes) as { url: string; ingredients_json: string } | undefined;
  return row ? { url: row.url, ingredients: JSON.parse(row.ingredients_json) as Ingredient[] } : undefined;
}

function writeFoundRecipe(
  db: Database.Database,
  dishName: string,
  adaptationNotes: string,
  url: string,
  ingredients: Ingredient[],
  foundAt: string,
): void {
  db.prepare(
    `INSERT INTO found_recipe (dish_name, adaptation_notes, url, ingredients_json, found_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dish_name, adaptation_notes) DO UPDATE
       SET url = excluded.url, ingredients_json = excluded.ingredients_json, found_at = excluded.found_at`,
  ).run(dishName, adaptationNotes, url, JSON.stringify(ingredients), foundAt);
}

/** Convenience for a week's Planned Dinners: one result per Dish, in input order. */
export async function resolveWeek(deps: ResolveDeps, dishes: Dish[]): Promise<ResolvedIngredients[]> {
  const results: ResolvedIngredients[] = [];
  for (const dish of dishes) results.push(await resolveIngredients(deps, dish));
  return results;
}

export interface PlanDinnerIngredients {
  /** The Planned Dinner as stored after this resolve (`sourceUrl` filled for an LLM-found recipe). */
  dinner: PlannedDinner;
  dish: Dish;
  resolved: ResolvedIngredients;
}

/**
 * Resolves the Ingredients of every Planned Dinner of a Weekly Plan that has a Dish (date
 * order; dinners without a Dish are omitted) and stores the LLM-found recipe link on the
 * dinner (`planned_dinner.source_url`, ADR-0003). The Shopping List (#31) builds on this.
 */
export async function resolvePlanIngredients(deps: ResolveDeps, planId: number): Promise<PlanDinnerIngredients[]> {
  const results: PlanDinnerIngredients[] = [];
  for (const dinner of listPlannedDinners(deps.db, planId)) {
    const dish = dinner.dishId === null ? undefined : getDish(deps.db, dinner.dishId);
    if (!dish) continue;
    const resolved = await resolveIngredients(deps, dish);
    if (resolved.source === "llm" && resolved.sourceUrl) {
      setPlannedDinnerSource(deps.db, planId, dinner.date, resolved.sourceUrl);
      dinner.sourceUrl = resolved.sourceUrl;
    }
    results.push({ dinner, dish, resolved });
  }
  return results;
}

async function resolveFromUrl(deps: ResolveDeps, url: string, adaptationNotes: string): Promise<ResolvedIngredients> {
  let page: string;
  try {
    page = await deps.fetchPage(url);
  } catch (err) {
    return { ingredients: [], source: "url", sourceUrl: url, degradedReason: `fetch failed: ${errorMessage(err)}` };
  }
  const contentHash = sha256(page);
  const cached = readCache(deps.db, url, contentHash, adaptationNotes);
  if (cached) return { ingredients: cached, source: "url", sourceUrl: url };

  const result = await deps.llm.extractIngredients(page, { adaptationNotes: adaptationNotes || undefined });
  if (!result.ok) return { ingredients: [], source: "url", sourceUrl: url, degradedReason: result.reason };
  const ingredients = result.value.map(toIngredient);
  writeCache(deps.db, url, contentHash, adaptationNotes, ingredients, (deps.now?.() ?? new Date()).toISOString());
  return { ingredients, source: "url", sourceUrl: url };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readCache(db: Database.Database, url: string, contentHash: string, adaptationNotes: string): Ingredient[] | undefined {
  const row = db
    .prepare(
      "SELECT ingredients_json FROM recipe_extraction WHERE url = ? AND content_hash = ? AND adaptation_notes = ?",
    )
    .get(url, contentHash, adaptationNotes) as { ingredients_json: string } | undefined;
  return row ? (JSON.parse(row.ingredients_json) as Ingredient[]) : undefined;
}

function writeCache(
  db: Database.Database,
  url: string,
  contentHash: string,
  adaptationNotes: string,
  ingredients: Ingredient[],
  extractedAt: string,
): void {
  db.prepare(
    `INSERT INTO recipe_extraction (url, content_hash, adaptation_notes, ingredients_json, extracted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url, content_hash, adaptation_notes) DO UPDATE
       SET ingredients_json = excluded.ingredients_json, extracted_at = excluded.extracted_at`,
  ).run(url, contentHash, adaptationNotes, JSON.stringify(ingredients), extractedAt);
}

/**
 * Maps an LLM Ingredient to the Dish shape (#20): `quantity` becomes a number when the
 * agent gave a number or a numeric string (decimal comma accepted), otherwise null.
 */
function toIngredient(ing: LlmIngredient): Ingredient {
  return { name: ing.name, quantity: toQuantity(ing.quantity), unit: ing.unit ?? null };
}

function toQuantity(q: number | string | undefined): number | null {
  if (typeof q === "number") return Number.isFinite(q) ? q : null;
  if (typeof q !== "string") return null;
  const n = Number(q.trim().replace(",", "."));
  return q.trim() !== "" && Number.isFinite(n) ? n : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
