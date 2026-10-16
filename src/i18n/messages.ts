/**
 * UI language types. `en.ts` is the source of keys; `sv.ts` must provide every one (the
 * compiler enforces it). Category labels live with the Main Category list
 * (`src/dishes/categories.ts`), keyed by stored key; labels are presentation only (FR-18).
 */
import type { en } from "./en.js";

export const LANGS = ["sv", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** Swedish ships first (FR-18). */
export const DEFAULT_LANG: Lang = "sv";

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;
