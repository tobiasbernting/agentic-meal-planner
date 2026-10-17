import { weekdayName, type Lang, type WeekdayKey } from "../i18n/index.js";

const WEEKDAY_KEYS: Record<string, WeekdayKey> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

/** "lör 10:20" in the household time zone. */
export function shortWhen(lang: Lang, iso: string, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_KEYS[part("weekday")];
  return `${weekday ? weekdayName(lang, weekday, "short").toLowerCase() : ""} ${part("hour")}:${part("minute")}`.trim();
}
