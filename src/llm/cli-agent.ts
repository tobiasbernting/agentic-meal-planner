import { spawn } from "node:child_process";
import type {
  ExtractIngredientsOptions,
  FoundRecipe,
  Ingredient,
  LlmAgent,
  LlmResult,
  LunchEntry,
  MatchPantryInput,
  PantryMatch,
  SelectDishesInput,
  SelectedDish,
} from "./types.js";

/** Main Category keys as decided in ticket #20 (see src/dishes/categories.ts once merged). */
const MAIN_CATEGORY_KEYS = [
  "pasta",
  "rice",
  "potatoes",
  "fish",
  "chicken",
  "beef",
  "pork",
  "vegetarian",
  "soup",
  "tacos",
  "other",
];

const INGREDIENT_SHAPE = '{"name": string, "quantity"?: number|string, "unit"?: string}';

export type ProcessRunner = (
  cmd: string,
  args: string[],
  stdin: string,
) => Promise<{ stdout: string; exitCode: number }>;

export interface CliAgentDeps {
  run?: ProcessRunner;
  /** Per-call timeout in milliseconds (default 120s). */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/** A validator turns unknown parsed JSON into T, or returns undefined when the shape is wrong. */
type Validator<T> = (json: unknown) => T | undefined;

const JSON_ONLY_NUDGE =
  "Your previous reply was not valid JSON of the requested shape. Respond with JSON only: no prose, no code fences, no explanation.";

/**
 * Runs the configured agent CLI (`agent_command`, e.g. `copilot -p`, `claude -p`) as a
 * subprocess, one prompt per call (ADR-0005). The prompt is passed both as the last
 * argument and on stdin. The first JSON value in stdout is parsed and validated; one
 * retry with a JSON-only nudge, then the result degrades (NFR-4). Never throws for
 * agent failure.
 */
export class CliAgent implements LlmAgent {
  private readonly cmd: string;
  private readonly baseArgs: string[];
  private readonly run: ProcessRunner;
  private readonly timeoutMs: number;

  constructor(agentCommand: string, deps: CliAgentDeps = {}) {
    const [cmd, ...args] = agentCommand.trim().split(/\s+/);
    this.cmd = cmd ?? "";
    this.baseArgs = args;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = deps.run ?? ((c, a, stdin) => spawnRunner(c, a, stdin, this.timeoutMs));
  }

  async extractLunchMenu(pageContent: string, weekStart: string): Promise<LlmResult<LunchEntry[]>> {
    const prompt =
      `Extract the school lunch menu for the week starting Monday ${weekStart} from this page. ` +
      `Respond with JSON only: an array of {"date": "YYYY-MM-DD", "rawText": string, "normalizedName"?: string, "mainCategory"?: string}. ` +
      `One entry per lunch dish per date. Possible mainCategory keys: ${MAIN_CATEGORY_KEYS.join(", ")} (use "other" when unsure).` +
      `\n\n${pageContent}`;
    return this.ask(prompt, validateLunchEntries);
  }

  async extractIngredients(
    recipePageContent: string,
    options: ExtractIngredientsOptions = {},
  ): Promise<LlmResult<Ingredient[]>> {
    const adaptation = options.adaptationNotes?.trim();
    const prompt =
      `Extract the ingredient list from this recipe page. ` +
      (adaptation ? `The household adapts this recipe; apply these adaptations: ${adaptation}. ` : "") +
      `Respond with JSON only: an array of ${INGREDIENT_SHAPE}.\n\n${recipePageContent}`;
    return this.ask(prompt, validateIngredients);
  }

  async findRecipe(dishName: string, options: ExtractIngredientsOptions = {}): Promise<LlmResult<FoundRecipe>> {
    const adaptation = options.adaptationNotes?.trim();
    const prompt =
      `Find a recipe on the web for the dish "${dishName}" and extract its ingredient list. ` +
      (adaptation ? `The household adapts this recipe; apply these adaptations: ${adaptation}. ` : "") +
      `Respond with JSON only: {"url": string, "ingredients": array of ${INGREDIENT_SHAPE}}.`;
    return this.ask(prompt, validateFoundRecipe);
  }

  async selectDishes(input: SelectDishesInput): Promise<LlmResult<SelectedDish[]>> {
    const prompt =
      `Pick one dinner dish per day for a household, from each day's candidates only. ` +
      `Prefer variety (avoid dishes in recentlyPlanned when alternatives exist, but repeats are allowed with a rationale). ` +
      `Respond with JSON only: an array of {"date": "YYYY-MM-DD", "dishId": string, "rationale": string}, one per day, in order.` +
      `\n\n${JSON.stringify(input, null, 2)}`;
    return this.ask(prompt, (json) => validateSelection(json, input));
  }

  async matchPantryItems(input: MatchPantryInput): Promise<LlmResult<PantryMatch[]>> {
    const prompt =
      `For each ingredient, decide whether it is one of the household's pantry items (match by meaning, ` +
      `including translations and the listed aliases; e.g. "whole milk" is the pantry item "milk"). ` +
      `Use null when no pantry item fits; when unsure, prefer null. ` +
      `Respond with JSON only: an array of {"ingredient": string, "pantryId": string | null}, one per ingredient, in order.` +
      `\n\n${JSON.stringify(input, null, 2)}`;
    return this.ask(prompt, (json) => validatePantryMatches(json, input));
  }

  /** Prompt, validate, retry once with a nudge, then degrade. */
  private async ask<T>(prompt: string, validate: Validator<T>): Promise<LlmResult<T>> {
    const attempts = [prompt, `${JSON_ONLY_NUDGE}\n\n${prompt}`];
    for (const text of attempts) {
      let out: { stdout: string; exitCode: number };
      try {
        out = await this.run(this.cmd, [...this.baseArgs, text], text);
      } catch (err) {
        return { ok: false, reason: `agent failed: ${errorMessage(err)}` };
      }
      if (out.exitCode !== 0) return { ok: false, reason: `agent exited with code ${out.exitCode}` };
      const value = validate(extractJson(out.stdout));
      if (value !== undefined) return { ok: true, value };
    }
    return { ok: false, reason: "invalid JSON after retry" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Finds the first JSON object or array in `text`, tolerating code fences and prose
 * around it. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") starts.push(i);
  }
  for (const start of starts) {
    const close = text[start] === "{" ? "}" : "]";
    let end = text.lastIndexOf(close);
    while (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        end = text.lastIndexOf(close, end - 1);
      }
    }
  }
  return undefined;
}

// --- validators (hand-written, no deps) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): v is string | undefined {
  return v === undefined || v === null || typeof v === "string";
}

function validateIngredient(v: unknown): Ingredient | undefined {
  if (!isRecord(v) || typeof v.name !== "string" || v.name.length === 0) return undefined;
  const { quantity, unit } = v;
  if (!(quantity === undefined || quantity === null || typeof quantity === "number" || typeof quantity === "string")) {
    return undefined;
  }
  if (!optionalString(unit)) return undefined;
  const out: Ingredient = { name: v.name };
  if (quantity !== undefined && quantity !== null) out.quantity = quantity;
  if (typeof unit === "string") out.unit = unit;
  return out;
}

function validateArray<T>(v: unknown, item: Validator<T>): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

export const validateIngredients: Validator<Ingredient[]> = (v) => validateArray(v, validateIngredient);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateLunchEntry(v: unknown): LunchEntry | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.date !== "string" || !ISO_DATE.test(v.date)) return undefined;
  if (typeof v.rawText !== "string" || v.rawText.length === 0) return undefined;
  if (!optionalString(v.normalizedName) || !optionalString(v.mainCategory)) return undefined;
  const out: LunchEntry = { date: v.date, rawText: v.rawText };
  if (typeof v.normalizedName === "string") out.normalizedName = v.normalizedName;
  if (typeof v.mainCategory === "string") out.mainCategory = v.mainCategory;
  return out;
}

export const validateLunchEntries: Validator<LunchEntry[]> = (v) => validateArray(v, validateLunchEntry);

export const validateFoundRecipe: Validator<FoundRecipe> = (v) => {
  if (!isRecord(v) || typeof v.url !== "string" || v.url.length === 0) return undefined;
  const ingredients = validateIngredients(v.ingredients);
  if (ingredients === undefined) return undefined;
  return { url: v.url, ingredients };
};

/** A selection is valid only when every chosen dish was a candidate for that date. */
export function validateSelection(v: unknown, input: SelectDishesInput): SelectedDish[] | undefined {
  const allowed = new Map(
    input.days.map((d, i) => [d.date, new Set((input.candidates[i] ?? []).map((c) => String(c.id)))]),
  );
  return validateArray(v, (item) => {
    if (!isRecord(item)) return undefined;
    const { date, rationale } = item;
    const dishId = typeof item.dishId === "number" ? String(item.dishId) : item.dishId;
    if (typeof date !== "string" || typeof dishId !== "string" || typeof rationale !== "string") return undefined;
    if (!allowed.get(date)?.has(dishId)) return undefined;
    return { date, dishId, rationale };
  });
}

/** A pantry match is valid only when every non-null `pantryId` is an id from the input pantry. */
export function validatePantryMatches(v: unknown, input: MatchPantryInput): PantryMatch[] | undefined {
  const known = new Set(input.pantry.map((p) => p.id));
  return validateArray(v, (item) => {
    if (!isRecord(item) || typeof item.ingredient !== "string") return undefined;
    const raw = item.pantryId;
    const pantryId = raw === undefined || raw === null ? null : typeof raw === "number" ? String(raw) : raw;
    if (typeof pantryId !== "string" && pantryId !== null) return undefined;
    if (pantryId !== null && !known.has(pantryId)) return undefined;
    return { ingredient: item.ingredient, pantryId };
  });
}

/** Default runner: node:child_process with a timeout; the prompt is also written to stdin. */
export function spawnRunner(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (err?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ stdout, exitCode: code ?? -1 });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, code));
    child.stdin.on("error", () => {}); // the agent may not read stdin
    child.stdin.end(stdin);
  });
}
