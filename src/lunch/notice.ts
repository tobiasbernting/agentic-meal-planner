import type Database from "better-sqlite3";
import { t, type Lang } from "../i18n/index.js";
import { listActiveSchools, type School } from "../schools/repo.js";
import { escapeHtml } from "../ui/layout.js";
import { mondayOf } from "../week.js";
import { listIngestOutcomes } from "./outcome.js";

/**
 * The "no lunch data" notice (FR-5) for `date`. With a `school`, the notice for that School;
 * without, the whole-day notice listing every active School. A School whose latest Ingest
 * Outcome for that week is no-data is named with its reason, one line each; otherwise the
 * generic message.
 */
export function renderNoLunchNotice(db: Database.Database, lang: Lang, date: string, school?: School): string {
  const weekStart = mondayOf(date);
  const failed = new Map(
    listIngestOutcomes(db)
      .filter((o) => o.status === "no-data" && o.reason && o.weekStart === weekStart)
      .map((o) => [o.schoolId, o.reason!]),
  );
  const affected = (school ? [school] : listActiveSchools(db)).filter((s) => failed.has(s.id));
  if (affected.length === 0) return `<p class="notice">${t(lang, "common.noLunchData")}</p>`;
  return affected.map((s) => `<p class="notice">${escapeHtml(s.name)}: ${escapeHtml(failed.get(s.id)!)}</p>`).join("\n");
}
