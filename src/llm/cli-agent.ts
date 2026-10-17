import { spawn } from "node:child_process";
import type { MainCategory } from "../dishes/categories.js";
import { silentLogger, type Logger } from "../logging/logger.js";
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

/** What one agent subprocess produced. `stderr` may be only its tail (the real spawner keeps the last 8 KB). */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs one agent subprocess. Rejects with `AgentTimeoutError` on timeout and with the spawn
 * error (`code: "ENOENT"` when the binary is missing) when the process cannot start.
 */
export type ProcessRunner = (cmd: string, args: string[], stdin: string) => Promise<ProcessResult>;

export interface CliAgentDeps {
  run?: ProcessRunner;
  /** Per-call timeout in milliseconds (default 120s). */
  timeoutMs?: number;
  /** Receives per-call info, failure warns and debug prompt/output records (default: silent). */
  log?: Logger;
}

/** Bytes of stderr the real spawner keeps, and the most a warn record carries per stream. */
export const OUTPUT_TAIL_CHARS = 8192;
/** The most of a stream's tail that goes into a failure `reason`. */
export const REASON_TAIL_CHARS = 500;

/** The agent subprocess ran past its timeout and was killed. Carries what it printed until then. */
export class AgentTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(`agent timed out after ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

type FailureCause = "exit" | "invalid-json" | "not-found" | "timeout" | "spawn-error";

/** The last `max` chars of `text`. */
function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
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
  /** The configured `agent_command`, trimmed (e.g. `"copilot -p"`). */
  readonly command: string;
  private readonly cmd: string;
  private readonly baseArgs: string[];
  private readonly run: ProcessRunner;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(agentCommand: string, deps: CliAgentDeps = {}) {
    this.log = deps.log ?? silentLogger;
    this.command = agentCommand.trim();
    const [cmd, ...args] = this.command.split(/\s+/);
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
    return this.ask("extractLunchMenu", prompt, validateLunchEntries);
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
    return this.ask("extractIngredients", prompt, validateIngredients);
  }

  async findRecipe(dishName: string, options: ExtractIngredientsOptions = {}): Promise<LlmResult<FoundRecipe>> {
    const adaptation = options.adaptationNotes?.trim();
    const prompt =
      `Find a recipe on the web for the dish "${dishName}" and extract its ingredient list. ` +
      (adaptation ? `The household adapts this recipe; apply these adaptations: ${adaptation}. ` : "") +
      `Respond with JSON only: {"url": string, "ingredients": array of ${INGREDIENT_SHAPE}}.`;
    return this.ask("findRecipe", prompt, validateFoundRecipe);
  }

  async selectDishes(input: SelectDishesInput): Promise<LlmResult<SelectedDish[]>> {
    const prompt =
      `Pick one dinner dish per day for a household, from each day's candidates only. ` +
      `Prefer variety (avoid dishes in recentlyPlanned when alternatives exist, but repeats are allowed with a rationale). ` +
      `Respond with JSON only: an array of {"date": "YYYY-MM-DD", "dishId": string, "rationale": string}, one per day, in order.` +
      `\n\n${JSON.stringify(input, null, 2)}`;
    return this.ask("selectDishes", prompt, (json) => validateSelection(json, input));
  }

  async suggestMainCategory(dishName: string, candidates: MainCategory[]): Promise<LlmResult<MainCategory | null>> {
    const prompt =
      `Propose the Main Category of the dish "${dishName}". Choose exactly one of: ${candidates.join(", ")}. ` +
      `Use null when none fits; when unsure prefer "other" or null. ` +
      `Respond with JSON only: {"category": string | null}.`;
    return this.ask("suggestMainCategory", prompt, (json) => {
      if (!isRecord(json)) return undefined;
      if (json.category === null) return null;
      return typeof json.category === "string" && (candidates as string[]).includes(json.category)
        ? (json.category as MainCategory)
        : undefined;
    });
  }

  async matchPantryItems(input: MatchPantryInput): Promise<LlmResult<PantryMatch[]>> {
    const prompt =
      `For each ingredient, decide whether it is one of the household's pantry items (match by meaning, ` +
      `including translations and the listed aliases; e.g. "whole milk" is the pantry item "milk"). ` +
      `Use null when no pantry item fits; when unsure, prefer null. ` +
      `Respond with JSON only: an array of {"ingredient": string, "pantryId": string | null}, one per ingredient, in order.` +
      `\n\n${JSON.stringify(input, null, 2)}`;
    return this.ask("matchPantryItems", prompt, (json) => validatePantryMatches(json, input));
  }

  /** Prompt, validate, retry once with a nudge, then degrade. Logs one info per call, a warn on failure. */
  private async ask<T>(operation: string, prompt: string, validate: Validator<T>): Promise<LlmResult<T>> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const attempts = [prompt, `${JSON_ONLY_NUDGE}\n\n${prompt}`];
    let last: ProcessResult = { stdout: "", stderr: "", exitCode: 0 };
    const fail = (cause: FailureCause, reason: string, out: Partial<ProcessResult>, attempt: number): LlmResult<T> => {
      const durationMs = elapsed();
      this.log.warn(
        {
          operation,
          command: this.command,
          cause,
          reason,
          exitCode: out.exitCode ?? null,
          durationMs,
          stdoutTail: tail(out.stdout ?? "", OUTPUT_TAIL_CHARS),
          stderrTail: tail(out.stderr ?? "", OUTPUT_TAIL_CHARS),
        },
        "agent call failed",
      );
      this.log.info({ operation, durationMs, outcome: "degraded", attempt }, "agent call finished");
      return { ok: false, reason };
    };
    for (const [i, text] of attempts.entries()) {
      const attempt = i + 1;
      this.log.debug({ operation, attempt, prompt: text }, "agent prompt");
      try {
        last = await this.run(this.cmd, [...this.baseArgs, text], text);
      } catch (err) {
        return this.failSpawn(err, fail, attempt);
      }
      this.log.debug({ operation, attempt, exitCode: last.exitCode, stdout: last.stdout, stderr: last.stderr }, "agent output");
      if (last.exitCode !== 0) {
        return fail("exit", `agent exited with code ${last.exitCode}: ${reasonTail(last.stderr)}`, last, attempt);
      }
      const value = validate(extractJson(last.stdout));
      if (value !== undefined) {
        this.log.info({ operation, durationMs: elapsed(), outcome: "ok", attempt }, "agent call finished");
        return { ok: true, value };
      }
    }
    return fail("invalid-json", `invalid JSON after retry: ${reasonTail(last.stdout)}`, last, attempts.length);
  }

  private failSpawn<T>(
    err: unknown,
    fail: (cause: FailureCause, reason: string, out: Partial<ProcessResult>, attempt: number) => LlmResult<T>,
    attempt: number,
  ): LlmResult<T> {
    if (err instanceof AgentTimeoutError) {
      return fail("timeout", err.message, { stdout: err.stdout, stderr: err.stderr }, attempt);
    }
    if (isRecord(err) && err.code === "ENOENT") {
      return fail("not-found", `agent binary not found: ${this.cmd}`, {}, attempt);
    }
    return fail("spawn-error", `agent failed: ${errorMessage(err)}`, {}, attempt);
  }
}

/** A stream's tail for a `reason`: trimmed, at most `REASON_TAIL_CHARS`. */
function reasonTail(text: string): string {
  return tail(text.trim(), REASON_TAIL_CHARS);
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

/**
 * Default runner: node:child_process with a timeout; the prompt is also written to stdin.
 * Keeps all of stdout and the last 8 KB of stderr. On timeout the process is SIGKILLed and
 * the promise rejects with `AgentTimeoutError`; a spawn failure rejects with Node's error
 * (`code: "ENOENT"` for a missing binary).
 */
export function spawnRunner(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AgentTimeoutError(timeoutMs, stdout, stderr));
    }, timeoutMs);
    const finish = (err?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ stdout, stderr, exitCode: code ?? -1 });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = tail(stderr + chunk, OUTPUT_TAIL_CHARS)));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, code));
    child.stdin.on("error", () => {}); // the agent may not read stdin
    child.stdin.end(stdin);
  });
}
