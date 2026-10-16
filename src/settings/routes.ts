/**
 * Settings UI (FR-15): the Quick Day template, cron schedule, variety window, Main Category
 * collision toggle, default prep limit, `agent_command` and Shopping List Sink config.
 * Keys and defaults live in src/planner/settings.ts; this module only renders and validates.
 */
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
  SETTING_VARIETY_WINDOW_WEEKS,
  readPlannerSettings,
  type PlannerSettings,
  type QuickDayOverrides,
} from "../planner/settings.js";
import { mondayOf } from "../planner/week.js";
import { localDate } from "../today/routes.js";
import { escapeHtml, NAV, page } from "../ui/layout.js";

NAV.push({ href: "/settings", label: "Settings" });

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

interface SettingsView {
  planner: PlannerSettings;
  cronExpression: string;
  agentCommand: string;
  shoppingListSinks: string;
}

function quickDayFields(template: PlannerSettings["quickDayTemplate"]): string {
  return WEEKDAYS.map((d) => {
    const minutes = template[d];
    return `<label>${WEEKDAY_LABELS[d]} <input type="number" min="0" name="quick_day_${d}" value="${minutes === undefined ? "" : minutes}" /></label>`;
  }).join("\n  ");
}

function notice(error?: string): string {
  return error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
}

function settingsPage(view: SettingsView, error?: string): string {
  const { planner } = view;
  const body = `<h1>Settings</h1>
${notice(error)}
<form method="post" action="/settings">
  <fieldset>
    <legend>Quick Day template (prep-time limit in minutes; blank = not a Quick Day)</legend>
  ${quickDayFields(planner.quickDayTemplate)}
  </fieldset>
  <p><a href="/settings/quick-days">Override Quick Days for a specific week</a></p>
  <label>Default prep limit (minutes) <input type="number" min="0" name="default_prep_limit_minutes" value="${planner.defaultPrepLimitMinutes}" /></label>
  <label>Plan schedule (cron, 5 fields) <input name="cron_expression" value="${escapeHtml(view.cronExpression)}" /></label>
  <label>Variety window (weeks) <input type="number" min="0" name="variety_window_weeks" value="${planner.varietyWindowWeeks}" /></label>
  <label><input type="checkbox" name="category_collision_enabled"${planner.categoryCollisionEnabled ? " checked" : ""} /> Avoid Main Category collisions with lunch</label>
  <label>Agent command (blank = no agent, degraded mode) <input name="agent_command" value="${escapeHtml(view.agentCommand)}" /></label>
  <label>Shopping List Sinks (JSON array) <textarea name="shopping_list_sinks">${escapeHtml(view.shoppingListSinks)}</textarea></label>
  <button type="submit">Save</button>
</form>`;
  return page({ title: "Settings", body });
}

type SettingsForm = Partial<Record<string, string>>;

/** A 5-field cron expression with the usual tokens (`*`, numbers, `,` `-` `/`); #34's scheduler parses it for real. */
const CRON_FIELD = /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/;
export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
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
function parseSettingsForm(body: SettingsForm): { values: Record<string, string> } | { error: string } {
  const template: PlannerSettings["quickDayTemplate"] = {};
  for (const d of WEEKDAYS) {
    const raw = body[`quick_day_${d}`]?.trim() ?? "";
    if (!raw) continue;
    const minutes = parseMinutes(raw);
    if (minutes === undefined) return { error: `${WEEKDAY_LABELS[d]}: Quick Day minutes must be a whole number.` };
    template[d] = minutes;
  }
  const defaultPrepLimit = parseMinutes(body.default_prep_limit_minutes);
  if (defaultPrepLimit === undefined) return { error: "Default prep limit must be a whole number of minutes." };
  const varietyWindow = parseMinutes(body.variety_window_weeks);
  if (varietyWindow === undefined) return { error: "Variety window must be a whole number of weeks." };
  const cron = body.cron_expression?.trim() ?? "";
  if (!isCronExpression(cron)) return { error: "Plan schedule must be a 5-field cron expression, e.g. 0 18 * * 0." };
  const sinks = body.shopping_list_sinks?.trim() || "[]";
  if (!isJsonArray(sinks)) return { error: "Shopping List Sinks must be a JSON array." };

  return {
    values: {
      [SETTING_QUICK_DAY_TEMPLATE]: JSON.stringify(template),
      [SETTING_DEFAULT_PREP_LIMIT_MINUTES]: String(defaultPrepLimit),
      [SETTING_VARIETY_WINDOW_WEEKS]: String(varietyWindow),
      [SETTING_CATEGORY_COLLISION_ENABLED]: body.category_collision_enabled !== undefined ? "true" : "false",
      [SETTING_CRON_EXPRESSION]: cron,
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

function quickDaysPage(settings: PlannerSettings, weekStart: string, error?: string): string {
  const days = effectiveQuickDays(settings, weekStart);
  const template: PlannerSettings["quickDayTemplate"] = {};
  for (const d of WEEKDAYS) {
    const v = days[d];
    if (typeof v === "number") template[d] = v;
  }
  const hasOverride = weekStart in settings.quickDayOverrides;
  const body = `<h1>Quick Days for the week of ${escapeHtml(weekStart)}</h1>
${notice(error)}
<p>${hasOverride ? "This week has its own Quick Days." : "This week follows the template."} Saving stores an override for this week only; blank = not a Quick Day.</p>
<form method="post" action="/settings/quick-days">
  <input type="hidden" name="week" value="${escapeHtml(weekStart)}" />
  ${quickDayFields(template)}
  <button type="submit">Save for this week</button>
</form>
<form method="post" action="/settings/quick-days/clear">
  <input type="hidden" name="week" value="${escapeHtml(weekStart)}" />
  <button type="submit"${hasOverride ? "" : " disabled"}>Remove override (follow the template)</button>
</form>
<p><a href="/settings">Back to Settings</a></p>`;
  return page({ title: "Quick Days", body });
}

function isMondayIso(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && mondayOf(value) === value;
}

function parseOverrideForm(body: SettingsForm): { week: string; days: Record<Weekday, number | null> } | { error: string } {
  const week = body.week?.trim();
  if (!isMondayIso(week)) return { error: "Week must be a Monday as YYYY-MM-DD." };
  const days = {} as Record<Weekday, number | null>;
  for (const d of WEEKDAYS) {
    const raw = body[`quick_day_${d}`]?.trim() ?? "";
    if (!raw) {
      days[d] = null;
      continue;
    }
    const minutes = parseMinutes(raw);
    if (minutes === undefined) return { error: `${WEEKDAY_LABELS[d]}: Quick Day minutes must be a whole number.` };
    days[d] = minutes;
  }
  return { week, days };
}

export const settingsRoutes: FeaturePlugin = async (app, { db, now }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  const currentView = (): SettingsView => ({
    planner: readPlannerSettings(db),
    cronExpression: readSetting(db, SETTING_CRON_EXPRESSION) ?? DEFAULT_CRON_EXPRESSION,
    agentCommand: readSetting(db, SETTING_AGENT_COMMAND) ?? "",
    shoppingListSinks: readSetting(db, SETTING_SHOPPING_LIST_SINKS) ?? "[]",
  });

  app.get("/settings", async (_req, reply) => {
    html(reply);
    return settingsPage(currentView());
  });

  app.post<{ Body: SettingsForm }>("/settings", async (req, reply) => {
    const parsed = parseSettingsForm(req.body ?? {});
    if ("error" in parsed) {
      html(reply.code(400));
      return settingsPage(currentView(), parsed.error);
    }
    db.transaction(() => {
      for (const [key, value] of Object.entries(parsed.values)) writeSetting(db, key, value);
    })();
    return reply.redirect("/settings", 303);
  });

  const writeOverrides = (overrides: QuickDayOverrides) =>
    writeSetting(db, SETTING_QUICK_DAY_OVERRIDES, JSON.stringify(overrides));

  app.get<{ Querystring: { week?: string } }>("/settings/quick-days", async (req, reply) => {
    const week = req.query.week ?? mondayOf(localDate(now()));
    if (!isMondayIso(week)) return reply.code(400).send("week must be a Monday as YYYY-MM-DD");
    html(reply);
    return quickDaysPage(readPlannerSettings(db), week);
  });

  app.post<{ Body: SettingsForm }>("/settings/quick-days", async (req, reply) => {
    const parsed = parseOverrideForm(req.body ?? {});
    if ("error" in parsed) {
      html(reply.code(400));
      const week = req.body?.week;
      return isMondayIso(week) ? quickDaysPage(readPlannerSettings(db), week, parsed.error) : parsed.error;
    }
    const overrides = readPlannerSettings(db).quickDayOverrides;
    overrides[parsed.week] = parsed.days;
    writeOverrides(overrides);
    return reply.redirect(`/settings/quick-days?week=${parsed.week}`, 303);
  });

  app.post<{ Body: SettingsForm }>("/settings/quick-days/clear", async (req, reply) => {
    const week = req.body?.week?.trim();
    if (!isMondayIso(week)) return reply.code(400).send("week must be a Monday as YYYY-MM-DD");
    const overrides = readPlannerSettings(db).quickDayOverrides;
    delete overrides[week];
    writeOverrides(overrides);
    return reply.redirect(`/settings/quick-days?week=${week}`, 303);
  });
};
