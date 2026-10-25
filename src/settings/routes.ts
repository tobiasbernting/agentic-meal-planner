/**
 * Settings UI (FR-15): the Quick Day template, cron schedule, variety window, Main Category
 * collision toggle, default prep limit, `agent_command`, the Daily Brief time (ADR-0010) and
 * Shopping List Sink config.
 * Keys and defaults live in src/planner/settings.ts; this module only renders and validates.
 */
import cron from "node-cron";
import type { FeaturePlugin } from "../app.js";
import { readSetting, writeSetting } from "../db.js";
import { WEEKDAYS, type Weekday } from "../dishes/repo.js";
import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_CRON_EXPRESSION,
  SETTING_AGENT_COMMAND,
  SETTING_CATEGORY_COLLISION_ENABLED,
  SETTING_CRON_EXPRESSION,
  SETTING_DEFAULT_PREP_LIMIT_MINUTES,
  SETTING_QUICK_DAY_OVERRIDES,
  SETTING_QUICK_DAY_TEMPLATE,
  SETTING_SHOPPING_LIST_SINKS,
  SETTING_SUGGESTION_STYLE,
  SETTING_TIMEZONE,
  householdToday,
  isTimezone,
  readTimezone,
  SETTING_VARIETY_WINDOW_WEEKS,
  readPlannerSettings,
  type PlannerSettings,
  type QuickDayOverrides,
} from "../planner/settings.js";
import { mondayOf } from "../week.js";
import { langOf, t, weekdayName, type Lang } from "../i18n/index.js";
import { agentBinaryFound } from "../logging/startup.js";
import { trelloSinkFromEnv } from "../sinks/trello.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { hasNoticeSink, SETTING_DAILY_BRIEF_TIME, SETTING_NOTICE_LANG } from "../notifier/send.js";

interface SettingsView {
  planner: PlannerSettings;
  cronExpression: string;
  agentCommand: string;
  /** What actually runs: the saved command, else AGENT_COMMAND; undefined for none. */
  effectiveAgentCommand: string | undefined;
  trelloConfigured: boolean;
  shoppingListSinks: string;
  timezone: string;
  dailyBriefTime: string;
  /** A configured sink carries notices (the webhook). */
  noticeSink: boolean;
}

function quickDayFields(lang: Lang, template: PlannerSettings["quickDayTemplate"]): string {
  return WEEKDAYS.map((d) => {
    const minutes = template[d];
    return `<label>${weekdayName(lang, d)} <input type="number" min="0" name="quick_day_${d}" value="${minutes === undefined ? "" : minutes}" /></label>`;
  }).join("\n  ");
}

function errorNotice(error?: string): string {
  return error ? notice({ text: error }) : "";
}

/** Språk: the language switch (moved here from the page header). Posts to /lang and returns. */
function languageSection(lang: Lang): string {
  const button = (value: Lang, label: string) =>
    `<button type="submit" name="lang" value="${value}"${value === lang ? ' class="primary" aria-pressed="true"' : ' aria-pressed="false"'}>${label}</button>`;
  return `<section id="language">
  <h2>${t(lang, "settings.language")}</h2>
  <form method="post" action="/lang" class="actions">
    <input type="hidden" name="next" value="/settings" />
    ${button("sv", "Svenska")} ${button("en", "English")}
  </form>
</section>`;
}

/** Cron weekday numbers in picker order (Monday first). */
const PICKER_DAYS: ReadonlyArray<readonly [number, Weekday]> = [
  [1, "mon"], [2, "tue"], [3, "wed"], [4, "thu"], [5, "fri"], [6, "sat"], [0, "sun"],
];

/** `M H * * D` with plain numbers is what the picker can express; anything else is "avancerat". */
export function cronToPicker(expression: string): { day: number; time: string } | undefined {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(expression.trim());
  if (!m) return undefined;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return undefined;
  return { day: Number(m[3]), time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function pickerToCron(day: string | undefined, time: string | undefined): string | undefined {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time?.trim() ?? "");
  if (!m || !/^[0-6]$/.test(day?.trim() ?? "")) return undefined;
  return `${Number(m[2])} ${Number(m[1])} * * ${day!.trim()}`;
}

interface WebhookEntry {
  url: string;
  format: "ntfy" | "json";
}

function parseSinkEntries(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null) : [];
  } catch {
    return [];
  }
}

function webhookOf(sinksJson: string): WebhookEntry {
  const entry = parseSinkEntries(sinksJson).find((e) => e.type === "webhook");
  return { url: typeof entry?.url === "string" ? entry.url : "", format: entry?.format === "json" ? "json" : "ntfy" };
}

/** Replace (or add, or drop) the first webhook entry; every other entry is kept as stored. */
function withWebhook(sinksJson: string, webhook: { url: string; format: string }): string {
  const entries = parseSinkEntries(sinksJson);
  const index = entries.findIndex((e) => e.type === "webhook");
  const next = webhook.url ? { type: "webhook", url: webhook.url, format: webhook.format === "json" ? "json" : "ntfy" } : undefined;
  if (index >= 0) {
    if (next) entries[index] = next;
    else entries.splice(index, 1);
  } else if (next) entries.push(next);
  return JSON.stringify(entries);
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${value}"${selected ? " selected" : ""}>${label}</option>`;
}

function scheduleFields(lang: Lang, cronExpression: string): string {
  const picker = cronToPicker(cronExpression);
  const days = PICKER_DAYS.map(([n, d]) => option(String(n), weekdayName(lang, d), picker?.day === n)).join("");
  const advanced = picker
    ? ""
    : `
  <details open>
    <summary>${t(lang, "settings.advanced")}</summary>
    <label>${t(lang, "settings.cron")} <input name="cron_expression" value="${escapeHtml(cronExpression)}" /></label>
  </details>`;
  return `<label>${t(lang, "settings.scheduleDay")} <select name="schedule_day">${picker ? "" : option("", "-", true)}${days}</select></label>
  <label>${t(lang, "settings.scheduleTime")} <input type="time" name="schedule_time" value="${picker?.time ?? ""}" /></label>${advanced}`;
}

function agentSection(lang: Lang, view: SettingsView): string {
  const effective = view.effectiveAgentCommand;
  const status = !effective
    ? t(lang, "more.settings.noAgent")
    : t(lang, agentBinaryFound(effective, process.env) ? "more.settings.agentFound" : "more.settings.agentMissing");
  const current = effective ? `<code>${escapeHtml(effective)}</code> ` : "";
  return `<p class="agent-status">${current}${status}</p>
  <label>${t(lang, "settings.agentCommand")} <input name="agent_command" value="${escapeHtml(view.agentCommand)}" placeholder="${escapeHtml(DEFAULT_AGENT_COMMAND)}" /></label>
  <label>${t(lang, "settings.suggestionStyle")} <input name="suggestion_style" value="${escapeHtml(view.planner.suggestionStyle)}" /></label>`;
}

function settingsPage(lang: Lang, view: SettingsView, error?: string): string {
  const { planner } = view;
  const webhook = webhookOf(view.shoppingListSinks);
  const body = `<h1>${t(lang, "settings.title")}</h1>
${errorNotice(error)}
<form method="post" action="/settings">
  <section id="week">
    <h2>${t(lang, "settings.section.week")}</h2>
    <fieldset>
      <legend>${t(lang, "settings.quickDayTemplate")}</legend>
    ${quickDayFields(lang, planner.quickDayTemplate)}
    </fieldset>
    <p><a href="/settings/quick-days">${t(lang, "settings.overrideLink")}</a></p>
  </section>
  <section id="planning">
    <h2>${t(lang, "settings.section.planning")}</h2>
    ${scheduleFields(lang, view.cronExpression)}
    <label>${t(lang, "settings.timezone")} <input name="timezone" value="${escapeHtml(view.timezone)}" placeholder="Europe/Stockholm" /></label>
    <label>${t(lang, "settings.defaultPrepLimit")} <input type="number" min="0" name="default_prep_limit_minutes" value="${planner.defaultPrepLimitMinutes}" /></label>
    <label>${t(lang, "settings.varietyWindow")} <input type="number" min="0" name="variety_window_weeks" value="${planner.varietyWindowWeeks}" /></label>
    <label><input type="checkbox" name="category_collision_enabled"${planner.categoryCollisionEnabled ? " checked" : ""} /> ${t(lang, "settings.collision")}</label>
  </section>
  <section id="agent">
    <h2>${t(lang, "settings.section.agent")}</h2>
    ${agentSection(lang, view)}
  </section>
  <section id="notices">
    <h2>${t(lang, "settings.section.notices")}</h2>
    <label>${t(lang, "settings.dailyBriefTime")} <input type="time" name="daily_brief_time" value="${escapeHtml(view.dailyBriefTime)}" /></label>
    <p class="muted">${t(lang, "settings.dailyBriefHelp")}</p>
    ${view.noticeSink ? "" : `<p class="no-sink">${t(lang, "settings.noSink")} <a href="#recipients">${t(lang, "settings.noSinkLink")}</a></p>`}
  </section>
  <section id="recipients">
    <h2>${t(lang, "settings.section.recipients")}</h2>
    <p>${t(lang, view.trelloConfigured ? "settings.trello.configured" : "settings.trello.missing")}</p>
    <label>${t(lang, "settings.webhookUrl")} <input type="url" name="webhook_url" value="${escapeHtml(webhook.url)}" placeholder="https://ntfy.sh/my-topic" /></label>
    <label>${t(lang, "settings.webhookFormat")} <select name="webhook_format">${option("ntfy", "ntfy", webhook.format === "ntfy")}${option("json", "JSON", webhook.format === "json")}</select></label>
    <p>${t(lang, "settings.secretsInEnv")}</p>
  </section>
  <button type="submit" class="primary">${t(lang, "common.save")}</button>
</form>
${languageSection(lang)}
<p><a href="/logs">${t(lang, "logs.title")}</a></p>`;
  return page({ title: t(lang, "settings.title"), body, lang, tab: "more" });
}

type SettingsForm = Partial<Record<string, string>>;

/** Validated by node-cron itself, so what Settings accepts is exactly what the scheduler (#34) can run. */
export function isCronExpression(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && cron.validate(trimmed);
}

function parseMinutes(raw: string | undefined): number | undefined {
  const text = raw?.trim() ?? "";
  if (!text) return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

/** Key/value pairs to store, or the first validation error. */
function parseSettingsForm(
  lang: Lang,
  body: SettingsForm,
  storedSinks: string,
): { values: Record<string, string>; cronExpression: string; timezone?: string } | { error: string } {
  const template: PlannerSettings["quickDayTemplate"] = {};
  for (const d of WEEKDAYS) {
    const raw = body[`quick_day_${d}`]?.trim() ?? "";
    if (!raw) continue;
    const minutes = parseMinutes(raw);
    if (minutes === undefined) return { error: t(lang, "settings.error.quickDay", { day: weekdayName(lang, d) }) };
    template[d] = minutes;
  }
  const defaultPrepLimit = parseMinutes(body.default_prep_limit_minutes);
  if (defaultPrepLimit === undefined) return { error: t(lang, "settings.error.prepLimit") };
  const varietyWindow = parseMinutes(body.variety_window_weeks);
  if (varietyWindow === undefined) return { error: t(lang, "settings.error.variety") };
  // A posted (advanced) expression wins; otherwise the weekday/time picker writes it.
  const cronExpression = body.cron_expression?.trim() || pickerToCron(body.schedule_day, body.schedule_time) || "";
  if (!isCronExpression(cronExpression)) return { error: t(lang, "settings.error.cron") };
  const timezone = body.timezone?.trim() ?? "";
  if (timezone && !isTimezone(timezone)) return { error: t(lang, "settings.error.timezone") };
  // `shopping_list_sinks` (raw JSON) is still accepted for scripted posts; the page itself only edits the webhook entry.
  let sinks = body.shopping_list_sinks?.trim() || storedSinks;
  if (!isJsonArray(sinks)) return { error: t(lang, "settings.error.sinks") };
  // Absent from scripted posts: the stored time stays.
  const dailyBrief = body.daily_brief_time?.trim();
  if (dailyBrief && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyBrief)) return { error: t(lang, "settings.error.dailyBrief") };
  if (body.webhook_url !== undefined) {
    const url = body.webhook_url.trim();
    if (url && !/^https?:\/\/\S+$/.test(url)) return { error: t(lang, "settings.error.webhook") };
    sinks = withWebhook(sinks, { url, format: body.webhook_format ?? "ntfy" });
  }

  return {
    cronExpression,
    ...(timezone ? { timezone } : {}),
    values: {
      [SETTING_QUICK_DAY_TEMPLATE]: JSON.stringify(template),
      [SETTING_DEFAULT_PREP_LIMIT_MINUTES]: String(defaultPrepLimit),
      [SETTING_VARIETY_WINDOW_WEEKS]: String(varietyWindow),
      [SETTING_CATEGORY_COLLISION_ENABLED]: body.category_collision_enabled !== undefined ? "true" : "false",
      [SETTING_CRON_EXPRESSION]: cronExpression,
      [SETTING_TIMEZONE]: timezone,
      [SETTING_SUGGESTION_STYLE]: body.suggestion_style?.trim() ?? "",
      [SETTING_AGENT_COMMAND]: body.agent_command?.trim() ?? "",
      [SETTING_SHOPPING_LIST_SINKS]: sinks,
      [SETTING_NOTICE_LANG]: lang,
      ...(dailyBrief === undefined ? {} : { [SETTING_DAILY_BRIEF_TIME]: dailyBrief }),
    },
  };
}

// --- per-week Quick Day overrides (FR-6d "overridable per week") ---

/** The week's effective Quick Days: the stored override if any, else the template. */
function effectiveQuickDays(settings: PlannerSettings, weekStart: string): Partial<Record<Weekday, number | null>> {
  return settings.quickDayOverrides[weekStart] ?? settings.quickDayTemplate;
}

function quickDaysPage(lang: Lang, settings: PlannerSettings, weekStart: string, error?: string): string {
  const days = effectiveQuickDays(settings, weekStart);
  const template: PlannerSettings["quickDayTemplate"] = {};
  for (const d of WEEKDAYS) {
    const v = days[d];
    if (typeof v === "number") template[d] = v;
  }
  const hasOverride = weekStart in settings.quickDayOverrides;
  const body = `<h1>${escapeHtml(t(lang, "settings.quickDays.heading", { week: weekStart }))}</h1>
${errorNotice(error)}
<p>${t(lang, hasOverride ? "settings.quickDays.hasOverride" : "settings.quickDays.followsTemplate")} ${t(lang, "settings.quickDays.help")}</p>
<form method="post" action="/settings/quick-days">
  <input type="hidden" name="week" value="${escapeHtml(weekStart)}" />
  ${quickDayFields(lang, template)}
  <button type="submit">${t(lang, "settings.quickDays.save")}</button>
</form>
<form method="post" action="/settings/quick-days/clear">
  <input type="hidden" name="week" value="${escapeHtml(weekStart)}" />
  <button type="submit"${hasOverride ? "" : " disabled"}>${t(lang, "settings.quickDays.clear")}</button>
</form>
<p><a href="/settings">${t(lang, "settings.back")}</a></p>`;
  return page({ title: t(lang, "settings.quickDays.title"), body, lang, tab: "more" });
}

function isMondayIso(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && mondayOf(value) === value;
}

function parseOverrideForm(lang: Lang, body: SettingsForm): { week: string; days: Record<Weekday, number | null> } | { error: string } {
  const week = body.week?.trim();
  if (!isMondayIso(week)) return { error: t(lang, "settings.error.week") };
  const days = {} as Record<Weekday, number | null>;
  for (const d of WEEKDAYS) {
    const raw = body[`quick_day_${d}`]?.trim() ?? "";
    if (!raw) {
      days[d] = null;
      continue;
    }
    const minutes = parseMinutes(raw);
    if (minutes === undefined) return { error: t(lang, "settings.error.quickDay", { day: weekdayName(lang, d) }) };
    days[d] = minutes;
  }
  return { week, days };
}

export const settingsRoutes: FeaturePlugin = async (app, ctx) => {
  const { db, now } = ctx;
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  const currentView = (): SettingsView => ({
    planner: readPlannerSettings(db),
    cronExpression: readSetting(db, SETTING_CRON_EXPRESSION) ?? DEFAULT_CRON_EXPRESSION,
    timezone: readTimezone(db) ?? "",
    agentCommand: readSetting(db, SETTING_AGENT_COMMAND) ?? "",
    shoppingListSinks: readSetting(db, SETTING_SHOPPING_LIST_SINKS) ?? "[]",
    effectiveAgentCommand: ctx.agentCommand,
    trelloConfigured: trelloSinkFromEnv(ctx.env ?? process.env) !== null,
    dailyBriefTime: readSetting(db, SETTING_DAILY_BRIEF_TIME) ?? "",
    noticeSink: hasNoticeSink(db, ctx.env ?? process.env),
  });

  app.get("/settings", async (req, reply) => {
    html(reply);
    return settingsPage(langOf(req), currentView());
  });

  app.post<{ Body: SettingsForm }>("/settings", async (req, reply) => {
    const lang = langOf(req);
    const parsed = parseSettingsForm(lang, req.body ?? {}, readSetting(db, SETTING_SHOPPING_LIST_SINKS) ?? "[]");
    if ("error" in parsed) {
      html(reply.code(400));
      return settingsPage(lang, currentView(), parsed.error);
    }
    db.transaction(() => {
      for (const [key, value] of Object.entries(parsed.values)) writeSetting(db, key, value);
    })();
    // The running scheduler (#34) picks up the new schedule without a restart; absent in tests.
    ctx.scheduler?.reschedule(parsed.cronExpression, parsed.timezone);
    return reply.redirect("/settings", 303);
  });

  const writeOverrides = (overrides: QuickDayOverrides) =>
    writeSetting(db, SETTING_QUICK_DAY_OVERRIDES, JSON.stringify(overrides));

  app.get<{ Querystring: { week?: string } }>("/settings/quick-days", async (req, reply) => {
    const lang = langOf(req);
    const week = req.query.week ?? mondayOf(householdToday(db, now()));
    if (!isMondayIso(week)) return reply.code(400).send(t(lang, "settings.error.week"));
    html(reply);
    return quickDaysPage(lang, readPlannerSettings(db), week);
  });

  app.post<{ Body: SettingsForm }>("/settings/quick-days", async (req, reply) => {
    const lang = langOf(req);
    const parsed = parseOverrideForm(lang, req.body ?? {});
    if ("error" in parsed) {
      html(reply.code(400));
      const week = req.body?.week;
      return isMondayIso(week) ? quickDaysPage(lang, readPlannerSettings(db), week, parsed.error) : parsed.error;
    }
    const overrides = readPlannerSettings(db).quickDayOverrides;
    overrides[parsed.week] = parsed.days;
    writeOverrides(overrides);
    return reply.redirect(`/settings/quick-days?week=${parsed.week}`, 303);
  });

  app.post<{ Body: SettingsForm }>("/settings/quick-days/clear", async (req, reply) => {
    const week = req.body?.week?.trim();
    if (!isMondayIso(week)) return reply.code(400).send(t(langOf(req), "settings.error.week"));
    const overrides = readPlannerSettings(db).quickDayOverrides;
    delete overrides[week];
    writeOverrides(overrides);
    return reply.redirect(`/settings/quick-days?week=${week}`, 303);
  });
};
