/**
 * Quick Add (ADR-0010): one typed phrase becomes a Todo. A small Swedish and English grammar
 * sets Due, Repeat and Member from words in the phrase ("imorgon", "fredag kl 17",
 * "varje måndag", "@Pappa"); what is left is the title. Pure and deterministic: no LLM, no
 * clock but `today`. The matched spans come back so the page can show them and offer
 * "behåll som text". `enhanceQuickAdd` is the seam a later agent ticket fills; it is a no-op.
 */
import { WEEKDAYS, type Weekday } from "../dishes/repo.js";
import type { Lang } from "../i18n/index.js";
import { addDays, weekdayOf } from "../week.js";
import type { RepeatRule } from "./repeat.js";

export type QuickAddField = "member" | "repeat" | "date" | "time";

export interface QuickAddSpan {
  start: number;
  end: number;
  field: QuickAddField;
}

export interface QuickAdd {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  repeat: RepeatRule | null;
  memberId: number | null;
  /** The matched words, in text order. */
  spans: QuickAddSpan[];
}

export interface QuickAddContext {
  lang: Lang;
  /** The household's current date (ISO). */
  today: string;
  members: { id: number; name: string }[];
}

const SV_WEEKDAYS: Record<Weekday, string[]> = {
  mon: ["måndag", "mån"],
  tue: ["tisdag", "tis"],
  wed: ["onsdag", "ons"],
  thu: ["torsdag", "tors", "tor"],
  fri: ["fredag", "fre"],
  sat: ["lördag", "lör"],
  sun: ["söndag", "sön"],
};

// English three-letter forms ("sat", "wed", "sun") are everyday words, so only full names count.
const EN_WEEKDAYS: Record<Weekday, string[]> = {
  mon: ["monday"],
  tue: ["tuesday"],
  wed: ["wednesday"],
  thu: ["thursday"],
  fri: ["friday"],
  sat: ["saturday"],
  sun: ["sunday"],
};

const weekdayNames = (lang: Lang) => (lang === "sv" ? SV_WEEKDAYS : EN_WEEKDAYS);

/** One regex alternation of every weekday form, longest first. */
function weekdayPattern(lang: Lang): string {
  return Object.values(weekdayNames(lang))
    .flat()
    .sort((a, b) => b.length - a.length)
    .join("|");
}

function weekdayFrom(lang: Lang, word: string): Weekday {
  const lower = word.toLowerCase();
  return WEEKDAYS.find((d) => weekdayNames(lang)[d].includes(lower))!;
}

/** The weekday's next date strictly after `today` (a weekday equal to today means next week). */
function nextWeekday(today: string, weekday: Weekday): string {
  let date = addDays(today, 1);
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** D/M with an optional year; without one, the next such date on or after today. Undefined when not a date. */
function dayMonth(today: string, d: number, m: number, year: number | undefined): string | undefined {
  if (m < 1 || m > 12 || d < 1) return undefined;
  const thisYear = Number(today.slice(0, 4));
  const y = year ?? thisYear;
  if (d > daysInMonth(y, m)) return year === undefined && d <= daysInMonth(y + 1, m) ? isoDate(y + 1, m, d) : undefined;
  const date = isoDate(y, m, d);
  if (year === undefined && date < today) return d <= daysInMonth(y + 1, m) ? isoDate(y + 1, m, d) : undefined;
  return date;
}

/** The first Due of a Repeat typed without a date: its first occurrence on or after today. */
export function firstOccurrence(rule: RepeatRule, today: string): string {
  switch (rule.kind) {
    case "daily":
    case "every_n_weeks":
    case "yearly":
      return today;
    case "weekdays": {
      let date = today;
      while (weekdayOf(date) === "sat" || weekdayOf(date) === "sun") date = addDays(date, 1);
      return date;
    }
    case "weekly": {
      let date = today;
      while (!rule.weekdays.includes(weekdayOf(date))) date = addDays(date, 1);
      return date;
    }
    case "monthly": {
      const y = Number(today.slice(0, 4));
      const m = Number(today.slice(5, 7));
      const here = isoDate(y, m, Math.min(rule.day, daysInMonth(y, m)));
      if (here >= today) return here;
      const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
      return isoDate(ny, nm, Math.min(rule.day, daysInMonth(ny, nm)));
    }
  }
}

function clock(hour: number, minute: number, meridiem?: string): string | undefined {
  let h = hour;
  if (meridiem) {
    if (h < 1 || h > 12) return undefined;
    const pm = meridiem.toLowerCase() === "pm";
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || minute > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

type Effect = { field: "repeat"; repeat: RepeatRule } | { field: "date"; date: string } | { field: "time"; time: string };

interface Rule {
  field: "repeat" | "date" | "time";
  pattern: string;
  effect: (m: RegExpExecArray, ctx: QuickAddContext) => Effect | undefined;
}

// A token starts and ends at a word edge; letters include å, ä and ö.
const START = "(?<![\\p{L}\\p{N}@/:])";
const END = "(?![\\p{L}\\p{N}])";

function rules(lang: Lang): Rule[] {
  const wd = weekdayPattern(lang);
  const weekly = (m: RegExpExecArray): Effect => {
    const days = new Set([...m[0].matchAll(new RegExp(`${START}(${wd})${END}`, "giu"))].map((w) => weekdayFrom(lang, w[1]!)));
    return { field: "repeat", repeat: { kind: "weekly", weekdays: WEEKDAYS.filter((d) => days.has(d)) } };
  };
  const monthly = (m: RegExpExecArray): Effect | undefined => {
    const day = Number(m[1]);
    return day >= 1 && day <= 31 ? { field: "repeat", repeat: { kind: "monthly", day } } : undefined;
  };
  const date = (m: RegExpExecArray, ctx: QuickAddContext): Effect | undefined => {
    const found = dayMonth(ctx.today, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    return found ? { field: "date", date: found } : undefined;
  };
  const time = (m: RegExpExecArray): Effect | undefined => {
    const found = clock(Number(m[1]), m[2] ? Number(m[2]) : 0, m[3]);
    return found ? { field: "time", time: found } : undefined;
  };
  const relative = (days: number) => (_m: RegExpExecArray, ctx: QuickAddContext): Effect => ({ field: "date", date: addDays(ctx.today, days) });
  const weekdayDate = (m: RegExpExecArray, ctx: QuickAddContext): Effect => ({ field: "date", date: nextWeekday(ctx.today, weekdayFrom(lang, m[1]!)) });
  const shared: Rule[] = [{ field: "date", pattern: "(\\d{1,2})/(\\d{1,2})(?:[-/](\\d{4}))?", effect: date }];
  if (lang === "sv") {
    return [
      { field: "repeat", pattern: "varje dag", effect: () => ({ field: "repeat", repeat: { kind: "daily" } }) },
      { field: "repeat", pattern: "varje vardag", effect: () => ({ field: "repeat", repeat: { kind: "weekdays" } }) },
      { field: "repeat", pattern: `varje (?:${wd})(?:(?:, ?| och )(?:${wd}))*`, effect: weekly },
      { field: "repeat", pattern: "varannan vecka", effect: () => ({ field: "repeat", repeat: { kind: "every_n_weeks", n: 2 } }) },
      { field: "repeat", pattern: "varje månad den (\\d{1,2})(?::[ae])?", effect: monthly },
      { field: "repeat", pattern: "varje år", effect: () => ({ field: "repeat", repeat: { kind: "yearly" } }) },
      { field: "date", pattern: "i ?övermorgon|övermorgon", effect: relative(2) },
      { field: "date", pattern: "i ?dag", effect: relative(0) },
      { field: "date", pattern: "i ?morgon", effect: relative(1) },
      { field: "date", pattern: `(?:på )?(${wd})`, effect: weekdayDate },
      ...shared,
      { field: "time", pattern: "kl\\.? ?(\\d{1,2})(?:[:.](\\d{2}))?", effect: time },
      { field: "time", pattern: "(\\d{1,2}):(\\d{2})", effect: time },
    ];
  }
  return [
    { field: "repeat", pattern: "every day|daily", effect: () => ({ field: "repeat", repeat: { kind: "daily" } }) },
    { field: "repeat", pattern: "every weekday|weekdays", effect: () => ({ field: "repeat", repeat: { kind: "weekdays" } }) },
    { field: "repeat", pattern: `every (?:${wd})(?:(?:, ?| and )(?:${wd}))*`, effect: weekly },
    { field: "repeat", pattern: "every other week", effect: () => ({ field: "repeat", repeat: { kind: "every_n_weeks", n: 2 } }) },
    { field: "repeat", pattern: "monthly on the (\\d{1,2})(?:st|nd|rd|th)?", effect: monthly },
    { field: "repeat", pattern: "every year|yearly", effect: () => ({ field: "repeat", repeat: { kind: "yearly" } }) },
    { field: "date", pattern: "today", effect: relative(0) },
    { field: "date", pattern: "tomorrow", effect: relative(1) },
    { field: "date", pattern: `(?:on )?(${wd})`, effect: weekdayDate },
    ...shared,
    { field: "time", pattern: "at (\\d{1,2})(?::(\\d{2}))? ?(am|pm)", effect: time },
    { field: "time", pattern: "at (\\d{1,2}):(\\d{2})", effect: time },
    { field: "time", pattern: "(\\d{1,2})(?::(\\d{2}))? ?(am|pm)", effect: time },
    { field: "time", pattern: "(\\d{1,2}):(\\d{2})", effect: time },
  ];
}

/** `@Name` for the longest Member name that follows an "@", case-insensitive. */
function memberSpan(text: string, members: QuickAddContext["members"]): { start: number; end: number; id: number } | undefined {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1]!)) continue;
    for (const member of byLength) {
      const name = member.name.toLowerCase();
      const end = i + 1 + name.length;
      if (name && lower.startsWith(name, i + 1) && !/[\p{L}\p{N}]/u.test(text[end] ?? "")) return { start: i, end, id: member.id };
    }
  }
  return undefined;
}

/**
 * Parses one Quick Add phrase. Fields claim their words in priority order (Member, Repeat,
 * date, time), each taking its earliest valid token that overlaps no claimed one; a second
 * token for a field already set stays text. A time without a date is today; a Repeat without a date starts at its first occurrence.
 * When nothing would be left of the title, the whole phrase is the title and nothing is parsed.
 */
export function parseQuickAdd(text: string, ctx: QuickAddContext): QuickAdd {
  const spans: QuickAddSpan[] = [];
  const free = (start: number, end: number) => spans.every((s) => end <= s.start || start >= s.end);
  let memberId: number | null = null;
  let repeat: RepeatRule | null = null;
  let dueDate: string | null = null;
  let dueTime: string | null = null;

  const member = memberSpan(text, ctx.members);
  if (member) {
    spans.push({ start: member.start, end: member.end, field: "member" });
    memberId = member.id;
  }
  for (const field of ["repeat", "date", "time"] as const) {
    // Every candidate for the field, earliest first and longest first at the same start.
    const candidates = rules(ctx.lang)
      .filter((rule) => rule.field === field)
      .flatMap((rule) => [...text.matchAll(new RegExp(`${START}(?:${rule.pattern})${END}`, "giu"))].map((m) => ({ m, rule })))
      .sort((a, b) => a.m.index - b.m.index || b.m[0].length - a.m[0].length);
    for (const { m, rule } of candidates) {
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      const effect = rule.effect(m, ctx);
      if (!effect) continue;
      if (effect.field === "repeat") repeat = effect.repeat;
      else if (effect.field === "date") dueDate = effect.date;
      else dueTime = effect.time;
      spans.push({ start, end, field });
      break;
    }
  }

  spans.sort((a, b) => a.start - b.start);
  let title = "";
  let at = 0;
  for (const span of spans) {
    title += `${text.slice(at, span.start)} `;
    at = span.end;
  }
  title = (title + text.slice(at)).replace(/\s+/g, " ").trim();
  if (!title) return plain(text);
  if (repeat && !dueDate) dueDate = firstOccurrence(repeat, ctx.today);
  if (dueTime && !dueDate) dueDate = ctx.today;
  return { title, dueDate, dueTime, repeat, memberId, spans };
}

/** The phrase as typed, nothing parsed ("behåll som text"). */
export function plain(text: string): QuickAdd {
  return { title: text.replace(/\s+/g, " ").trim(), dueDate: null, dueTime: null, repeat: null, memberId: null, spans: [] };
}

/** The seam for an agent-assisted parse (a later ticket). Today it returns the parse unchanged. */
export async function enhanceQuickAdd(parsed: QuickAdd, _text: string, _ctx: QuickAddContext): Promise<QuickAdd> {
  return parsed;
}
