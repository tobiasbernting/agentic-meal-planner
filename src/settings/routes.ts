/**
 * Settings UI (FR-15): the Quick Day template, cron schedule, variety window, Main Category
 * collision toggle, default prep limit, `agent_command` and Shopping List Sink config.
 * Keys and defaults live in src/planner/settings.ts; this module only renders and validates.
 */
import cron from "node-cron";
import type { FeaturePlugin } from "../app.js";
import { readSetting, writeSetting } from "../db.js";
import { WEEKDAYS, type Weekday } from "../dishes/repo.js";
import {
  DEFAULT_CRON_EXPRESSION,
  SETTING_AGENT_COMMAND,
  SETTING_CATEGORY_COLLISION_ENABLED,
  SETTING_CRON_EXPRESSION,
  SETTING_DEFAULT_PREP_LIMIT_MINUTES,
  SETTING_QUICK_DAY_OVERRIDES,
  SETTING_QUICK_DAY_TEMPLATE,
  SETTING_SHOPPING_LIST_SINKS,
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
import { escapeHtml, NAV, page } from "../ui/layout.js";

NAV.push({ href: "/settings", label: "nav.settings" });

interface SettingsView {
  planner: PlannerSettings;
  cronExpression: string;
  agentCommand: string;
  shoppingListSinks: string;
  timezone: string;
}

function quickDayFields(lang: Lang, template: PlannerSettings["quickDayTemplate"]): string {
  return WEEKDAYS.map((d) => {
    const minutes = template[d];
    return `<label>${weekdayName(lang, d)} <input type="number" min="0" name="quick_day_${d}" value="${minutes === undefined ? "" : minutes}" /></label>`;
  }).join("\n  ");
}

function notice(error?: string): string {
  return error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
}

function settingsPage(lang: Lang, view: SettingsView, error?: string): string {
  const { planner } = view;
  const body = `<h1>${t(lang, "settings.title")}</h1>
${notice(error)}
<form method="post" action="/settings">
  <fieldset>
    <legend>${t(lang, "settings.quickDayTemplate")}</legend>
  ${quickDayFields(lang, planner.quickDayTemplate)}
  </fieldset>
  <p><a href="/settings/quick-days">${t(lang, "settings.overrideLink")}</a></p>
  <label>${t(lang, "settings.defaultPrepLimit")} <input type="number" min="0" name="default_prep_limit_minutes" value="${planner.defaultPrepLimitMinutes}" /></label>
  <label>${t(lang, "settings.cron")} <input name="cron_expression" value="${escapeHtml(view.cronExpression)}" /></label>
  <label>${t(lang, "settings.timezone")} <input name="timezone" value="${escapeHtml(view.timezone)}" placeholder="Europe/Stockholm" /></label>
  <label>${t(lang, "settings.varietyWindow")} <input type="number" min="0" name="variety_window_weeks" value="${planner.varietyWindowWeeks}" /></label>
  <label><input type="checkbox" name="category_collision_enabled"${planner.categoryCollisionEnabled ? " checked" : ""} /> ${t(lang, "settings.collision")}</label>
  <label>${t(lang, "settings.agentCommand")} <input name="agent_command" value="${escapeHtml(view.agentCommand)}" /></label>
  <label>${t(lang, "settings.sinks")} <code>[{"type":"webhook","url":"https://ntfy.sh/my-topic","format":"ntfy"}]</code> <textarea name="shopping_list_sinks">${escapeHtml(view.shoppingListSinks)}</textarea></label>
  <button type="submit">${t(lang, "common.save")}</button>
</form>`;
  return page({ title: t(lang, "settings.title"), body, lang });
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
  const cronExpression = body.cron_expression?.trim() ?? "";
  if (!isCronExpression(cronExpression)) return { error: t(lang, "settings.error.cron") };
  const timezone = body.timezone?.trim() ?? "";
  if (timezone && !isTimezone(timezone)) return { error: t(lang, "settings.error.timezone") };
  const sinks = body.shopping_list_sinks?.trim() || "[]";
  if (!isJsonArray(sinks)) return { error: t(lang, "settings.error.sinks") };

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
      [SETTING_AGENT_COMMAND]: body.agent_command?.trim() ?? "",
      [SETTING_SHOPPING_LIST_SINKS]: sinks,
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
${notice(error)}
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
  return page({ title: t(lang, "settings.quickDays.title"), body, lang });
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
  });

  app.get("/settings", async (req, reply) => {
    html(reply);
    return settingsPage(langOf(req), currentView());
  });

  app.post<{ Body: SettingsForm }>("/settings", async (req, reply) => {
    const lang = langOf(req);
    const parsed = parseSettingsForm(lang, req.body ?? {});
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
