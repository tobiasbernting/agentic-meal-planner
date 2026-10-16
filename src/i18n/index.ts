import { en } from "./en.js";
import { DEFAULT_LANG, isLang, type Dictionary, type Lang, type MessageKey } from "./messages.js";
import { sv } from "./sv.js";

export { DEFAULT_LANG, LANGS, isLang, type Dictionary, type Lang, type MessageKey } from "./messages.js";

const DICTIONARIES: Record<Lang, Dictionary> = { sv, en };

/** Name of the cookie that selects the UI language (set by the language switch, #39). */
export const LANG_COOKIE = "lang";

/** Translates `key`; `{name}` placeholders are replaced from `params` (not HTML-escaped). */
export function t(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const text = DICTIONARIES[lang][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The request's language: a valid `lang` cookie, else Swedish. */
export function langOf(req: { headers: { cookie?: string | undefined } }): Lang {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LANG_COOKIE) {
      const value = rest.join("=").trim();
      if (isLang(value)) return value;
    }
  }
  return DEFAULT_LANG;
}

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Localised weekday name, full ("Monday") or short ("Mon"). */
export function weekdayName(lang: Lang, weekday: WeekdayKey, form: "full" | "short" = "full"): string {
  return t(lang, `weekday.${form}.${weekday}`);
}
