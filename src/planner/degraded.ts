/**
 * Degraded reasons (spec #71): what the planner could not do, stored as a stable code plus
 * parameters so the Plan page can say it in household language on the day it affects. A `null`
 * date means the whole week (no agent, or the agent failed). The raw technical text is `detail`:
 * it goes to Logs and is never stored or shown.
 */
import { MAIN_CATEGORIES, isMainCategory } from "../dishes/categories.js";
import type { ExclusionCode } from "../engine/filter.js";
import { t, type Lang } from "../i18n/index.js";

/** The hard rules a dropped suggestion is reported by; a suggestion is never out of rotation. */
export type DayRuleCode = Exclude<ExclusionCode, "not-in-rotation">;

export type DegradedCode = "no-agent" | "agent-failed" | "pick-not-eligible" | "seed-fallback" | "suggestion-invalid" | DayRuleCode | "unknown";

export interface DegradedReason {
  code: DegradedCode;
  /** The affected date, `YYYY-MM-DD`; `null` for the whole week. */
  date: string | null;
  params?: Record<string, string | number>;
}

/** A reason as the planner produces it: the stored part plus the raw text for Logs. */
export interface DegradedReasonDraft extends DegradedReason {
  detail: string;
  /** Logged but not stored: the day is already explained by another reason. */
  logOnly?: boolean;
}

const DATED = /^(\d{4}-\d{2}-\d{2}): /;

/**
 * Reads the stored JSON. Plans saved before reason codes hold raw strings: those keep their
 * date (when they start with one) and become `unknown`, so no raw text reaches a page.
 */
export function parseDegradedReasons(json: string): DegradedReason[] {
  const raw = JSON.parse(json) as unknown[];
  return raw.map((r): DegradedReason => {
    if (typeof r === "object" && r !== null && "code" in r) return r as DegradedReason;
    const dated = typeof r === "string" ? DATED.exec(r) : null;
    return { code: "unknown", date: dated?.[1] ?? null };
  });
}

/** The stored part only: `detail` and log-only reasons stay out of the database. */
export function toStored(reasons: (DegradedReason | DegradedReasonDraft)[]): DegradedReason[] {
  return reasons
    .filter((r) => !("logOnly" in r && r.logOnly))
    .map(({ code, date, params }) => (params ? { code, date, params } : { code, date }));
}

/** The reason in household language. */
export function describeDegraded(lang: Lang, reason: DegradedReason): string {
  const params: Record<string, string | number> = { ...reason.params };
  const category = params.category;
  if (typeof category === "string" && isMainCategory(category)) {
    params.category = MAIN_CATEGORIES[category][lang].toLocaleLowerCase(lang);
  }
  const key = reason.code === "unknown" && reason.date === null ? "degraded.unknown.week" : (`degraded.${reason.code}` as const);
  return t(lang, key, params);
}
