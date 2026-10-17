import { silentLogger, type Logger } from "../logging/logger.js";
import type { OnProgress } from "../plan-run/phase.js";
import type Database from "better-sqlite3";
import { isMainCategory } from "../dishes/categories.js";
import type { LlmAgent } from "../llm/index.js";
import { createSchoolPlugins, findPlugin, type FetchPage } from "../plugins/schools/index.js";
import { listActiveSchools, type School } from "../schools/repo.js";
import type { LunchEntry, SchoolPlugin } from "../types.js";
import { recordIngestOutcome } from "./outcome.js";
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
  /** Plan Run progress reports (Phase transitions); omitted outside a Plan Run. */
  onProgress?: OnProgress;
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
 * already stored is not fetched again unless `force` is set. Every attempt records the
 * School's Ingest Outcome, replacing the previous one. Dates a scrape does not return
 * keep their stored entry.
 */
export async function ingestWeek(deps: IngestDeps, weekStart: string, options: IngestOptions = {}): Promise<IngestResult> {
  deps.onProgress?.({ phase: "lunch-ingest" });
  const runLog = deps.log ?? silentLogger;
  const log = runLog.child({ component: "lunch-ingest" });
  const plugins = deps.plugins ?? createSchoolPlugins(deps.fetchPage, runLog.child({ component: "school-plugin" }));
  const results: SchoolIngestResult[] = [];
  for (const school of listActiveSchools(deps.db)) {
    const { entries, ...result } = await ingestSchool(deps, plugins, school, weekStart, options.force === true, log);
    recordIngestOutcome(deps.db, {
      schoolId: school.id,
      weekStart,
      status: result.status === "ok" ? "fetched" : result.status,
      reason: result.reason ?? null,
      recordedAt: deps.now().toISOString(),
    });
    log.info({ schoolId: school.id, status: result.status, entries, weekStart }, "ingest summary");
    results.push(result);
  }
  return { results, changed: results.flatMap((r) => r.changed) };
}

async function ingestSchool(
  deps: IngestDeps,
  plugins: SchoolPlugin[],
  school: School,
  weekStart: string,
  force: boolean,
  log: Logger,
): Promise<SchoolIngestResult & { entries: number }> {
  const dates = weekDates(weekStart);
  const stored = new Map(listLunchEntries(deps.db, school.id, dates[0]!, dates[dates.length - 1]!).map((e) => [e.date, e]));
  if (!force && weekdayDates(weekStart).every((date) => stored.has(date))) {
    return { schoolId: school.id, status: "cached", changed: [], entries: stored.size };
  }

  const scraped = await scrape(deps, plugins, school, weekStart, log);
  if (!scraped.ok) return { schoolId: school.id, status: "no-data", reason: scraped.reason, changed: [], entries: 0 };

  const entries = mergeByDate(scraped.value.filter((e) => dates.includes(e.date)));
  if (entries.length === 0) {
    log.warn({ schoolId: school.id, url: school.url, reason: "no entries for this week" }, "no lunch entries for this week");
    return { schoolId: school.id, status: "no-data", reason: "no entries for this week", changed: [], entries: 0 };
  }

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
  return { schoolId: school.id, status: "ok", changed, entries: entries.length };
}

type ScrapeResult = { ok: true; value: LunchEntry[] } | { ok: false; reason: string };

async function scrape(deps: IngestDeps, plugins: SchoolPlugin[], school: School, weekStart: string, log: Logger): Promise<ScrapeResult> {
  const plugin = findPlugin(school.url, plugins);
  if (plugin) {
    try {
      return { ok: true, value: await plugin.scrape(school.url, weekStart) };
    } catch (error) {
      log.warn({ schoolId: school.id, url: school.url, pluginId: plugin.id, reason: message(error), err: error }, "school plugin failed");
      return { ok: false, reason: `plugin ${plugin.id} failed: ${message(error)}` };
    }
  }
  log.info({ schoolId: school.id, url: school.url }, "using LLM fallback");
  let page: string;
  try {
    page = await deps.fetchPage(school.url);
  } catch (error) {
    log.warn({ schoolId: school.id, url: school.url, reason: message(error), err: error }, "menu fetch failed");
    return { ok: false, reason: `fetch failed: ${message(error)}` };
  }
  const extracted = await deps.llm.extractLunchMenu(page, weekStart);
  if (!extracted.ok) log.warn({ schoolId: school.id, url: school.url, reason: extracted.reason }, "agent lunch extraction failed");
  return extracted;
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
