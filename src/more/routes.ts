/**
 * Mer (spec #71): the index of library and admin pages, each with a count or status line so
 * the setup's health shows at a glance. Read-only; every number comes from the owning repo.
 */
import type { AppContext, FeaturePlugin } from "../app.js";
import { listDishes } from "../dishes/repo.js";
import { langOf, t, weekdayName, type Lang, type MessageKey, type WeekdayKey } from "../i18n/index.js";
import { agentBinaryFound } from "../logging/startup.js";
import { listIngestOutcomes, type IngestOutcome } from "../lunch/outcome.js";
import { listPantryItems } from "../pantry/repo.js";
import { readTimezone } from "../planner/settings.js";
import { listSchools } from "../schools/repo.js";
import { escapeHtml, page } from "../ui/layout.js";

type Countable = "dish" | "school" | "pantryItem";

function count(lang: Lang, noun: Countable, n: number): string {
  return t(lang, `count.${noun}.${n === 1 ? "one" : "other"}` as MessageKey, { n });
}

const WEEKDAY_KEYS: Record<string, WeekdayKey> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

/** "lör 10:20" in the household time zone. */
function shortWhen(lang: Lang, iso: string, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_KEYS[part("weekday")];
  return `${weekday ? weekdayName(lang, weekday, "short").toLowerCase() : ""} ${part("hour")}:${part("minute")}`.trim();
}

/** The most recent Ingest Outcome across Schools, as a status phrase. */
function schoolStatus(lang: Lang, outcomes: IngestOutcome[], timeZone: string | undefined): string {
  const latest = outcomes.reduce<IngestOutcome | undefined>((a, b) => (!a || b.recordedAt > a.recordedAt ? b : a), undefined);
  if (!latest) return t(lang, "more.schools.never");
  if (latest.status === "no-data") return t(lang, "more.schools.noData");
  return t(lang, "more.schools.fetched", { when: shortWhen(lang, latest.recordedAt, timeZone) });
}

function agentStatus(lang: Lang, agentCommand: string | undefined): string {
  if (!agentCommand) return t(lang, "more.settings.noAgent");
  return t(lang, agentBinaryFound(agentCommand, process.env) ? "more.settings.agentFound" : "more.settings.agentMissing");
}

interface Row {
  href: string;
  label: string;
  status: string;
}

function rows(lang: Lang, ctx: AppContext): Row[] {
  const dishes = listDishes(ctx.db);
  const schools = listSchools(ctx.db);
  const schoolLine = schools.length
    ? `${count(lang, "school", schools.length)}, ${schoolStatus(lang, listIngestOutcomes(ctx.db), readTimezone(ctx.db))}`
    : count(lang, "school", 0);
  return [
    {
      href: "/dishes",
      label: t(lang, "nav.dishes"),
      status: t(lang, "more.dishes", { dishes: count(lang, "dish", dishes.length), rotation: dishes.filter((d) => d.inRotation).length }),
    },
    { href: "/schools", label: t(lang, "nav.schools"), status: schoolLine },
    { href: "/pantry", label: t(lang, "nav.pantry"), status: count(lang, "pantryItem", listPantryItems(ctx.db).length) },
    { href: "/settings", label: t(lang, "nav.settings"), status: agentStatus(lang, ctx.agentCommand) },
    { href: "/logs", label: t(lang, "logs.title"), status: t(lang, "more.logs.level", { level: ctx.logs.getLevel() }) },
  ];
}

function morePage(lang: Lang, ctx: AppContext): string {
  const list = rows(lang, ctx)
    .map((r) => `<li><a class="row-link" href="${r.href}"><span class="row-label">${escapeHtml(r.label)}</span><span class="row-status">${escapeHtml(r.status)}</span></a></li>`)
    .join("\n");
  const body = `<header class="page-head"><h1>${t(lang, "more.title")}</h1></header>
<ul class="rows">
${list}
</ul>`;
  return page({ title: t(lang, "more.title"), body, lang, tab: "more" });
}

export const moreRoutes: FeaturePlugin = async (app, ctx) => {
  app.get("/more", async (req, reply) => reply.type("text/html").send(morePage(langOf(req), ctx)));
};
