/**
 * Typed readers over the `settings` table for the keys the Planner Agent uses (docs/DESIGN.md).
 * Every key has a default so a fresh database plans without any configuration. Ticket #35
 * builds the Settings UI on these exported key constants.
 */
import type Database from "better-sqlite3";
import { readSetting } from "../db.js";
import { isWeekday, type Weekday } from "../dishes/repo.js";
import { normaliseName } from "../text.js";
import { localDate } from "../week.js";

/** Variety Preference window (weeks), FR-7. */
export const SETTING_VARIETY_WINDOW_WEEKS = "variety_window_weeks";
/** FR-6b Main Category collision rule, `"true"` | `"false"`. */
export const SETTING_CATEGORY_COLLISION_ENABLED = "category_collision_enabled";
/** Recurring Quick Day template: JSON `{ "<weekday>": <minutes> }`. */
export const SETTING_QUICK_DAY_TEMPLATE = "quick_day_template";
/** Per-week overrides: JSON `{ "<weekStart>": { "<weekday>": <minutes> | null } }`; `null` = not a Quick Day that week. */
export const SETTING_QUICK_DAY_OVERRIDES = "quick_day_overrides";
/** Fallback Quick Day limit when the template gives no usable number, FR-6d. */
export const SETTING_DEFAULT_PREP_LIMIT_MINUTES = "default_prep_limit_minutes";
/** When the scheduled plan run happens (5-field cron), FR-9. */
export const SETTING_CRON_EXPRESSION = "cron_expression";
/** The agent CLI used for all LLM work (ADR-0005); blank/unset = NoAgent, FR-16. */
/** FR-15 default agent command; applied by src/server.ts when neither a setting nor AGENT_COMMAND is set. */
export const DEFAULT_AGENT_COMMAND = "copilot -p";
export const SETTING_AGENT_COMMAND = "agent_command";
/** JSON array of Shopping List Sink configs (secrets stay in env vars, never here). */
export const SETTING_SHOPPING_LIST_SINKS = "shopping_list_sinks";

/** Free-text style for Suggested Dishes; blank/unset = the default. */
export const SETTING_SUGGESTION_STYLE = "suggestion_style";
export const DEFAULT_SUGGESTION_STYLE = "family-friendly Swedish home cooking for a household with kids";

/** Sunday 18:00 (FR-9). */
export const DEFAULT_CRON_EXPRESSION = "0 18 * * 0";

export type QuickDayTemplate = Partial<Record<Weekday, number>>;
export type QuickDayOverrides = Record<string, Partial<Record<Weekday, number | null>>>;

export interface PlannerSettings {
  varietyWindowWeeks: number;
  categoryCollisionEnabled: boolean;
  quickDayTemplate: QuickDayTemplate;
  quickDayOverrides: QuickDayOverrides;
  defaultPrepLimitMinutes: number;
  suggestionStyle: string;
}

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  varietyWindowWeeks: 3,
  categoryCollisionEnabled: true,
  quickDayTemplate: { tue: 30 },
  quickDayOverrides: {},
  defaultPrepLimitMinutes: 30,
  suggestionStyle: DEFAULT_SUGGESTION_STYLE,
};

function readInt(db: Database.Database, key: string, fallback: number): number {
  const raw = readSetting(db, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function readBool(db: Database.Database, key: string, fallback: boolean): boolean {
  const raw = normaliseName(readSetting(db, key) ?? "");
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function readJsonObject(db: Database.Database, key: string): Record<string, unknown> | undefined {
  const raw = readSetting(db, key);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toWeekdayMap<T>(obj: Record<string, unknown>, accept: (v: unknown) => v is T): Partial<Record<Weekday, T>> {
  const out: Partial<Record<Weekday, T>> = {};
  for (const [k, v] of Object.entries(obj)) if (isWeekday(k) && accept(v)) out[k] = v;
  return out;
}

const isMinutes = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isMinutesOrNull = (v: unknown): v is number | null => v === null || isMinutes(v);

export function readPlannerSettings(db: Database.Database): PlannerSettings {
  const d = DEFAULT_PLANNER_SETTINGS;
  const template = readJsonObject(db, SETTING_QUICK_DAY_TEMPLATE);
  const overridesRaw = readJsonObject(db, SETTING_QUICK_DAY_OVERRIDES);
  const quickDayOverrides: QuickDayOverrides = {};
  for (const [weekStart, v] of Object.entries(overridesRaw ?? {})) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      quickDayOverrides[weekStart] = toWeekdayMap(v as Record<string, unknown>, isMinutesOrNull);
    }
  }
  return {
    varietyWindowWeeks: readInt(db, SETTING_VARIETY_WINDOW_WEEKS, d.varietyWindowWeeks),
    categoryCollisionEnabled: readBool(db, SETTING_CATEGORY_COLLISION_ENABLED, d.categoryCollisionEnabled),
    quickDayTemplate: template ? toWeekdayMap(template, isMinutes) : { ...d.quickDayTemplate },
    quickDayOverrides,
    defaultPrepLimitMinutes: readInt(db, SETTING_DEFAULT_PREP_LIMIT_MINUTES, d.defaultPrepLimitMinutes),
    suggestionStyle: readSetting(db, SETTING_SUGGESTION_STYLE)?.trim() || d.suggestionStyle,
  };
}

/**
 * FR-6d: the Quick Day limit for one weekday of one week, or `null` when it is not a Quick Day.
 * Precedence: this week's override (a `null` override cancels the template) → template →
 * `default_prep_limit_minutes` when the template names the day but gives no usable limit (0).
 */
export function quickDayLimitFor(settings: PlannerSettings, weekStart: string, weekday: Weekday): number | null {
  const override = settings.quickDayOverrides[weekStart];
  let limit: number | null | undefined = override && weekday in override ? override[weekday] : undefined;
  if (limit === undefined) limit = settings.quickDayTemplate[weekday];
  if (limit === undefined || limit === null) return null;
  return limit > 0 ? limit : settings.defaultPrepLimitMinutes;
}

/** IANA time zone the household and the weekly run live in; blank = the process time zone (`TZ`). */
export const SETTING_TIMEZONE = "timezone";

/** True when `name` is an IANA time zone this runtime knows. */
export function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The configured time zone, or `undefined` for the process time zone (blank or invalid values count as unset). */
export function readTimezone(db: Database.Database): string | undefined {
  const name = readSetting(db, SETTING_TIMEZONE)?.trim();
  return name && isTimezone(name) ? name : undefined;
}

/** The household's "today" (`YYYY-MM-DD`) at `now`, in the configured time zone. */
export function householdToday(db: Database.Database, now: Date): string {
  return localDate(now, readTimezone(db));
}
