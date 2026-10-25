/**
 * Notices through the webhook sink (ADR-0010): the Daily Brief at the configured minute and a
 * message at each Todo's Due time. They go to every configured sink that carries notices; a
 * Due Todo whose Member has a topic also goes to that topic. Run from the household minute
 * tick. Sends are logged and never throw; nothing is recorded as a Shopping List push.
 */
import type Database from "better-sqlite3";
import { readSetting, writeSetting } from "../db.js";
import { isLang, t, type Lang } from "../i18n/index.js";
import { getList } from "../lists/repo.js";
import { listName } from "../lists/view.js";
import { silentLogger, type Logger } from "../logging/logger.js";
import { getMember } from "../members/repo.js";
import { householdToday, readTimezone } from "../planner/settings.js";
import { configuredSinks } from "../sinks/registry.js";
import type { Env, FetchLike } from "../sinks/types.js";
import { localTime } from "../week.js";
import { dailyBrief, type Notice } from "./brief.js";

/** HH:MM in the household time zone; empty or unset: no Daily Brief. */
export const SETTING_DAILY_BRIEF_TIME = "daily_brief_time";
/** The language notices are written in: the UI language of whoever last saved Settings. */
export const SETTING_NOTICE_LANG = "notice_lang";
/** The household date the Daily Brief last went out, so a restart within the minute does not repeat it. */
const SETTING_BRIEF_SENT_ON = "daily_brief_sent_on";

/** A Due time this many minutes past still gets its message (a tick may be late). */
const DUE_WINDOW_MINUTES = 5;

export interface NotifierDeps {
  db: Database.Database;
  now: () => Date;
  env?: Env;
  fetch?: FetchLike;
  log?: Logger;
}

export function noticeLang(db: Database.Database): Lang {
  const stored = readSetting(db, SETTING_NOTICE_LANG);
  return isLang(stored) ? stored : "sv";
}

/** True when at least one configured sink carries notices. */
export function hasNoticeSink(db: Database.Database, env: Env = process.env): boolean {
  return configuredSinks(db, env).some((sink) => sink.notify !== undefined);
}

/** Sends one notice to every notice-carrying sink (to `topic` when given). Returns how many accepted it. */
export async function sendNotice(deps: NotifierDeps, notice: Notice, what: string, topic?: string): Promise<number> {
  const log = (deps.log ?? silentLogger).child({ component: "notifier" });
  let sent = 0;
  try {
    for (const sink of configuredSinks(deps.db, deps.env ?? process.env, deps.fetch)) {
      if (!sink.notify) continue;
      let result;
      try {
        result = await sink.notify({ kind: "notice", title: notice.title, text: notice.text, ...(topic ? { topic } : {}) });
      } catch (err) {
        result = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        sent += 1;
        log.info({ sinkId: sink.id, what, ...(topic ? { topic } : {}) }, "notice sent");
      } else log.warn({ sinkId: sink.id, what, reason: result.error }, "notice failed");
    }
  } catch (err) {
    log.warn({ what, reason: err instanceof Error ? err.message : String(err) }, "notice aborted");
  }
  return sent;
}

/** Sends the Daily Brief when this minute is the configured one and it has not gone out today. */
export async function runDailyBrief(deps: NotifierDeps): Promise<boolean> {
  const { db } = deps;
  const time = readSetting(db, SETTING_DAILY_BRIEF_TIME)?.trim();
  if (!time) return false;
  const now = deps.now();
  const today = householdToday(db, now);
  if (localTime(now, readTimezone(db)) !== time || readSetting(db, SETTING_BRIEF_SENT_ON) === today) return false;
  writeSetting(db, SETTING_BRIEF_SENT_ON, today);
  const brief = dailyBrief(db, noticeLang(db), today);
  if (!brief) return false;
  await sendNotice(deps, brief, "daily-brief");
  return true;
}

function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

interface DueRow {
  id: number;
  list_id: number;
  name: string;
  due_time: string;
  member_id: number | null;
  member_name: string | null;
}

/**
 * Sends a message for every open Todo whose Due date and time just passed (within a few
 * minutes) and that has had none, then marks it reminded. A Todo's Member with a topic gets a
 * second copy at that topic. Returns how many Todos were due.
 */
export async function sendDueReminders(deps: NotifierDeps): Promise<number> {
  const { db } = deps;
  const now = deps.now();
  const today = householdToday(db, now);
  const nowMinutes = minutesOf(localTime(now, readTimezone(db)));
  const rows = (
    db
      .prepare(
        `SELECT id, list_id, name, due_time, member_id, member_name FROM list_item
         WHERE due_date = ? AND due_time IS NOT NULL AND reminded_at IS NULL AND checked_at IS NULL
           AND list_id IN (SELECT id FROM list WHERE kind = 'todo') ORDER BY due_time, id`,
      )
      .all(today) as DueRow[]
  ).filter((row) => {
    const due = minutesOf(row.due_time);
    return due <= nowMinutes && nowMinutes - due <= DUE_WINDOW_MINUTES;
  });
  const lang = noticeLang(db);
  for (const row of rows) {
    db.prepare("UPDATE list_item SET reminded_at = ? WHERE id = ?").run(now.toISOString(), row.id);
    const list = getList(db, row.list_id);
    const text = [t(lang, "brief.reminderText", { time: row.due_time, list: list ? listName(lang, list) : "" }), row.member_name ?? ""].filter(Boolean).join(" · ");
    const notice = { title: row.name, text };
    await sendNotice(deps, notice, "due");
    const topic = row.member_id === null ? undefined : getMember(db, row.member_id)?.topic;
    if (topic) await sendNotice(deps, notice, "due", topic);
  }
  return rows.length;
}
