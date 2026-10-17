import type Database from "better-sqlite3";
import { t, type Lang } from "../i18n/index.js";
import { listActiveSchools, type School } from "../schools/repo.js";
import { escapeHtml } from "../ui/layout.js";
import { mondayOf } from "../week.js";
import { listIngestOutcomes } from "./outcome.js";

/** Renders the "no lunch data" notice for a date, optionally for one School. */
export type NoLunchNotice = (lang: Lang, date: string, school?: School) => string;

/**
 * The "no lunch data" notice (FR-5), with the Ingest Outcomes and active Schools loaded once:
 * build one per page render and call it per School and day. With a `school`, the notice for
 * that School; without, the whole-day notice listing every active School. A School whose
 * latest Ingest Outcome for that date's week is no-data is named with its reason, one line
 * each; otherwise the generic message.
 */
export function noLunchNotice(db: Database.Database): NoLunchNotice {
  const failed = new Map<number, { weekStart: string; reason: string }>();
  for (const o of listIngestOutcomes(db)) {
    if (o.status === "no-data" && o.reason) failed.set(o.schoolId, { weekStart: o.weekStart, reason: o.reason });
  }
  let active: School[] | undefined;
  return (lang, date, school) => {
    const weekStart = mondayOf(date);
    const reasonFor = (s: School) => {
      const f = failed.get(s.id);
      return f && f.weekStart === weekStart ? f.reason : undefined;
    };
    const affected = (school ? [school] : (active ??= listActiveSchools(db))).filter((s) => reasonFor(s) !== undefined);
    if (affected.length === 0) return `<p class="notice">${t(lang, "common.noLunchData")}</p>`;
    return affected.map((s) => `<p class="notice">${escapeHtml(s.name)}: ${escapeHtml(reasonFor(s)!)}</p>`).join("\n");
  };
}
