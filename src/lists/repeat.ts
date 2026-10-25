/**
 * Repeat (ADR-0010): a Todo's fixed-schedule rule, stored as structured JSON and never as free
 * text, so the next occurrence is computed here, pure and testable (NFR-3). Rules are anchored
 * on the Todo's Due date: `nextDue` is the first occurrence strictly after it.
 */
import { WEEKDAYS, type Weekday } from "../dishes/repo.js";
import { t, weekdayName, type Lang } from "../i18n/index.js";
import { addDays, weekdayOf } from "../week.js";

export type RepeatRule =
  | { kind: "daily" }
  | { kind: "weekdays" }
  | { kind: "weekly"; weekdays: Weekday[] }
  | { kind: "every_n_weeks"; n: number }
  | { kind: "monthly"; day: number }
  | { kind: "yearly" };

export const REPEAT_KINDS = ["daily", "weekdays", "weekly", "every_n_weeks", "monthly", "yearly"] as const;
export type RepeatKind = RepeatRule["kind"];

export function isRepeatKind(value: unknown): value is RepeatKind {
  return typeof value === "string" && (REPEAT_KINDS as readonly string[]).includes(value);
}

/** Parses a stored rule; malformed JSON or an unknown shape reads as no Repeat. */
export function parseRepeat(json: string | null | undefined): RepeatRule | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || !("kind" in value)) return null;
    const rule = value as Record<string, unknown>;
    switch (rule.kind) {
      case "daily":
      case "weekdays":
      case "yearly":
        return { kind: rule.kind };
      case "weekly": {
        const weekdays = Array.isArray(rule.weekdays) ? WEEKDAYS.filter((d) => (rule.weekdays as unknown[]).includes(d)) : [];
        return weekdays.length ? { kind: "weekly", weekdays } : null;
      }
      case "every_n_weeks":
        return Number.isInteger(rule.n) && (rule.n as number) >= 2 ? { kind: "every_n_weeks", n: rule.n as number } : null;
      case "monthly":
        return Number.isInteger(rule.day) && (rule.day as number) >= 1 && (rule.day as number) <= 31 ? { kind: "monthly", day: rule.day as number } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function ymd(date: string): { y: number; m: number; d: number } {
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) };
}

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The first occurrence of the rule strictly after `dueDate` (ISO date). */
export function nextDue(rule: RepeatRule, dueDate: string): string {
  switch (rule.kind) {
    case "daily":
      return addDays(dueDate, 1);
    case "weekdays": {
      let next = addDays(dueDate, 1);
      while (weekdayOf(next) === "sat" || weekdayOf(next) === "sun") next = addDays(next, 1);
      return next;
    }
    case "weekly": {
      let next = addDays(dueDate, 1);
      for (let i = 0; i < 7 && !rule.weekdays.includes(weekdayOf(next)); i++) next = addDays(next, 1);
      return next;
    }
    case "every_n_weeks":
      return addDays(dueDate, 7 * rule.n);
    case "monthly": {
      // The anchor day is the rule's, so the 31st rolls to the 30th in April and back to the 31st in May.
      const { y, m } = ymd(dueDate);
      const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
      return iso(ny, nm, Math.min(rule.day, daysInMonth(ny, nm)));
    }
    case "yearly": {
      const { y, m, d } = ymd(dueDate);
      return iso(y + 1, m, Math.min(d, daysInMonth(y + 1, m)));
    }
  }
}

/** "varje måndag och onsdag", "every other week": the rule in household words. */
export function describeRepeat(rule: RepeatRule, lang: Lang): string {
  switch (rule.kind) {
    case "daily":
      return t(lang, "repeat.daily");
    case "weekdays":
      return t(lang, "repeat.weekdays");
    case "weekly": {
      const names = rule.weekdays.map((d) => weekdayName(lang, d).toLowerCase());
      const days = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")}${t(lang, "repeat.and")}${names[names.length - 1]}`;
      return t(lang, "repeat.weekly", { days });
    }
    case "every_n_weeks":
      return rule.n === 2 ? t(lang, "repeat.every_2_weeks") : t(lang, "repeat.every_n_weeks", { n: rule.n });
    case "monthly":
      return t(lang, "repeat.monthly", { day: lang === "en" ? ordinal(rule.day) : `${rule.day}:e` });
    case "yearly":
      return t(lang, "repeat.yearly");
  }
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
