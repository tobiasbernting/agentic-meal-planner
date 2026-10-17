import type { Logger } from "../logging/logger.js";
import type Database from "better-sqlite3";
import { isMainCategory } from "../dishes/categories.js";
import type { LlmAgent } from "../llm/index.js";
import { createSchoolPlugins, findPlugin, type FetchPage } from "../plugins/schools/index.js";
import { listActiveSchools, type School } from "../schools/repo.js";
import type { LunchEntry, SchoolPlugin } from "../types.js";
import { listLunchEntries, upsertLunchEntry } from "./repo.js";
import { weekDates, weekdayDates } from "../week.js";

export interface IngestDeps {
  db: Database.Database;
  llm: LlmAgent;
  fetchPage: FetchPage;
  now: () => Date;
  /** Defaults to the registry in src/plugins/schools; override in tests. */
  plugins?: SchoolPlugin[];
  /** Run logger (bound to `runId`); defaults to `silentLogger`. */
  log?: Logger;
}

export interface IngestOptions {
  /** Re-scrape even when the week is cached; `changed` then lists stored entries that differ. */
  force?: boolean;
}

/** A stored Lunch Entry whose text differs after a forced re-scrape (FR-9 "menu changed" notice). */
export interface LunchChange {
  schoolId: number;
  date: string;
  before: string;
  after: string;
}

export interface SchoolIngestResult {
  schoolId: number;
  /** `cached`: nothing fetched; `no-data`: nothing stored for this week, see `reason` (FR-5 notice). */
  status: "ok" | "cached" | "no-data";
  reason?: string;
  changed: LunchChange[];
}

export interface IngestResult {
  results: SchoolIngestResult[];
  changed: LunchChange[];
}

/**
 * Lunch ingest for one week (FR-4): for each active School, the first School Plugin claiming
 * its URL scrapes it; otherwise the page is fetched and `llm.extractLunchMenu` extracts the
 * menu. Results are cached per School and date: a School whose five weekdays (Mon-Fri) are
 * already stored is not fetched again unless `force` is set. Dates a scrape does not return
 * keep their stored entry.
 */
export async function ingestWeek(deps: IngestDeps, weekStart: string, options: IngestOptions = {}): Promise<IngestResult> {
  const plugins = deps.plugins ?? createSchoolPlugins(deps.fetchPage);
  const results: SchoolIngestResult[] = [];
  for (const school of listActiveSchools(deps.db)) {
    results.push(await ingestSchool(deps, plugins, school, weekStart, options.force === true));
  }
  return { results, changed: results.flatMap((r) => r.changed) };
}

async function ingestSchool(
  deps: IngestDeps,
  plugins: SchoolPlugin[],
  school: School,
  weekStart: string,
  force: boolean,
): Promise<SchoolIngestResult> {
  const dates = weekDates(weekStart);
  const stored = new Map(listLunchEntries(deps.db, school.id, dates[0]!, dates[dates.length - 1]!).map((e) => [e.date, e]));
  if (!force && weekdayDates(weekStart).every((date) => stored.has(date))) {
    return { schoolId: school.id, status: "cached", changed: [] };
  }

  const scraped = await scrape(deps, plugins, school, weekStart);
  if (!scraped.ok) return { schoolId: school.id, status: "no-data", reason: scraped.reason, changed: [] };

  const entries = mergeByDate(scraped.value.filter((e) => dates.includes(e.date)));
  if (entries.length === 0) return { schoolId: school.id, status: "no-data", reason: "no entries for this week", changed: [] };

  const fetchedAt = deps.now().toISOString();
  const changed: LunchChange[] = [];
  const store = deps.db.transaction(() => {
    for (const entry of entries) {
      const before = stored.get(entry.date);
      if (before && before.rawText !== entry.rawText) {
        changed.push({ schoolId: school.id, date: entry.date, before: before.rawText, after: entry.rawText });
      }
      upsertLunchEntry(deps.db, {
        schoolId: school.id,
        date: entry.date,
        rawText: entry.rawText,
        normalizedName: entry.normalizedName ?? null,
        mainCategory: isMainCategory(entry.mainCategory) ? entry.mainCategory : null,
        fetchedAt,
      });
    }
  });
  store();
  return { schoolId: school.id, status: "ok", changed };
}

type ScrapeResult = { ok: true; value: LunchEntry[] } | { ok: false; reason: string };

async function scrape(deps: IngestDeps, plugins: SchoolPlugin[], school: School, weekStart: string): Promise<ScrapeResult> {
  const plugin = findPlugin(school.url, plugins);
  if (plugin) {
    try {
      return { ok: true, value: await plugin.scrape(school.url, weekStart) };
    } catch (error) {
      return { ok: false, reason: `plugin ${plugin.id} failed: ${message(error)}` };
    }
  }
  let page: string;
  try {
    page = await deps.fetchPage(school.url);
  } catch (error) {
    return { ok: false, reason: `fetch failed: ${message(error)}` };
  }
  return deps.llm.extractLunchMenu(page, weekStart);
}

/** One Lunch Entry per date: texts joined by newline, first non-empty normalized name/category kept. */
function mergeByDate(entries: LunchEntry[]): LunchEntry[] {
  const byDate = new Map<string, LunchEntry>();
  for (const entry of entries) {
    const rawText = entry.rawText.trim();
    if (rawText === "") continue;
    const existing = byDate.get(entry.date);
    if (!existing) {
      byDate.set(entry.date, { ...entry, rawText });
      continue;
    }
    existing.rawText = `${existing.rawText}\n${rawText}`;
    existing.normalizedName ??= entry.normalizedName;
    existing.mainCategory ??= entry.mainCategory;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
