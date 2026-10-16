/**
 * Shared port types from docs/DESIGN.md. Dates are ISO `YYYY-MM-DD` strings (not `Date`),
 * matching how they are stored in SQLite (see the notes README conventions).
 */

/** One served lunch at a School on one date (GLOSSARY: Lunch Entry). */
export interface LunchEntry {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** The menu text as published; normalization happens downstream. */
  rawText: string;
  normalizedName?: string;
  /** Main Category key from the fixed list (see src/dishes/categories.ts). */
  mainCategory?: string;
}

/** A deterministic scraper for one menu format (ADR-0004). See CONTRIBUTING.md. */
export interface SchoolPlugin {
  /** e.g. "skolmaten-se" */
  id: string;
  /** Does this plugin handle this menu URL? */
  claims(url: string): boolean;
  /** `weekStart` is the week's Monday as `YYYY-MM-DD`. */
  scrape(url: string, weekStart: string): Promise<LunchEntry[]>;
}
