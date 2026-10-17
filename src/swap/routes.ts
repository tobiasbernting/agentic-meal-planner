/**
 * Swap (spec #71): replace one Planned Dinner by hand. Byt loads an HTMX fragment listing the
 * Dishes eligible on that date (the deterministic engine's hard rules, `eligibleDishesOn`).
 * Picking one writes that Planned Dinner with the localised "vald för hand" rationale and
 * rebuilds the week's Shopping List. Swap is unavailable (hidden, and refused over HTTP) on a
 * confirmed plan and while the week's Plan Run is in flight. Plan and Today render the control
 * with `swapControl`.
 */
import type Database from "better-sqlite3";
import type { FastifyReply } from "fastify";
import type { AppContext, FeaturePlugin } from "../app.js";
import { getDish } from "../dishes/repo.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { runLogger } from "../logging/logger.js";
import { eligibleDishesOn } from "../planner/eligible.js";
import { getPlanForWeek, setPlannedDinnerDish, type WeeklyPlan } from "../planner/repo.js";
import { buildShoppingList } from "../shopping/build.js";
import { escapeHtml, page } from "../ui/layout.js";
import { isIsoDate, mondayOf } from "../week.js";

/** The week's plan when its dinner on `date` may be swapped: generated (not confirmed), no Plan Run in flight. */
function swappablePlan(ctx: Pick<AppContext, "db" | "planRuns">, date: string): WeeklyPlan | undefined {
  const weekStart = mondayOf(date);
  const run = ctx.planRuns.get(weekStart);
  if (run !== undefined && "inFlight" in run) return undefined;
  const plan = getPlanForWeek(ctx.db, weekStart);
  if (!plan || plan.status !== "generated" || !plan.dinners.some((d) => d.date === date)) return undefined;
  return plan;
}

/** A same-site path to return to; anything else falls back to the date's Plan week. */
function safeNext(next: string | undefined, date: string): string {
  return next && /^\/(?![/\\])/.test(next) ? next : `/plan?week=${mondayOf(date)}`;
}

/**
 * The Byt control for a day row (the almanac's `swapHtml`), or "" to hide it when Swap is
 * unavailable. `next` is where the page returns after a pick. Without JavaScript the link opens
 * the list as a page; with HTMX the list replaces the button in place.
 */
export function swapControl(ctx: Pick<AppContext, "db" | "planRuns">, lang: Lang, date: string, next: string): string {
  const plan = swappablePlan(ctx, date);
  if (!plan) return "";
  // A day with no Dish reads "Välj rätt"; the list and the write are the same as Byt's.
  const empty = plan.dinners.find((d) => d.date === date)?.dishId == null;
  const url = escapeHtml(`/plan/swap?date=${date}&next=${encodeURIComponent(next)}`);
  return `<a class="button" href="${url}" hx-get="${url}" hx-target="this" hx-swap="outerHTML">${t(lang, empty ? "day.pick" : "day.swap")}</a>`;
}

function swapList(db: Database.Database, lang: Lang, date: string, currentDishId: number | null, next: string): string {
  const dishes = eligibleDishesOn(db, date).filter((dish) => dish.id !== currentDishId);
  const items = dishes
    .map((dish) => {
      const minutes = dish.prepTimeMinutes === null ? "" : ` <span class="row-status">${t(lang, "dishes.prepMinutes", { n: dish.prepTimeMinutes })}</span>`;
      return `<li><button type="submit" class="row" name="dishId" value="${dish.id}"><span class="row-label">${escapeHtml(dish.name)}</span>${minutes}</button></li>`;
    })
    .join("");
  const list = dishes.length ? `<ul class="rows">${items}</ul>` : `<p>${t(lang, "swap.none")}</p>`;
  return `<form class="swap-list" method="post" action="/plan/swap">
<input type="hidden" name="date" value="${date}" />
<input type="hidden" name="next" value="${escapeHtml(next)}" />
<div class="label">${t(lang, "swap.pick")}</div>
${list}
<a class="button quiet" href="${escapeHtml(next)}">${t(lang, "swap.cancel")}</a>
</form>`;
}

interface SwapQuery {
  date?: string;
  next?: string;
}

interface SwapForm extends SwapQuery {
  dishId?: string;
}

export const swapRoutes: FeaturePlugin = async (app, ctx) => {
  /**
   * The date and its swappable plan, or undefined after refusing the request in plain text:
   * 400 for a malformed date, 409 when Swap is unavailable on it.
   */
  const swapTarget = (reply: FastifyReply, lang: Lang, raw: string | undefined): { date: string; plan: WeeklyPlan } | undefined => {
    const refuse = (code: 400 | 409) => void reply.code(code).type("text/plain; charset=utf-8").send(t(lang, "swap.refused"));
    if (!isIsoDate(raw)) return refuse(400);
    const plan = swappablePlan(ctx, raw);
    if (!plan) return refuse(409);
    return { date: raw, plan };
  };

  app.get<{ Querystring: SwapQuery }>("/plan/swap", async (req, reply) => {
    const lang = langOf(req);
    const target = swapTarget(reply, lang, req.query.date);
    if (!target) return reply;
    const { date, plan } = target;
    const next = safeNext(req.query.next, date);
    const current = plan.dinners.find((d) => d.date === date)?.dishId ?? null;
    const list = swapList(ctx.db, lang, date, current, next);
    reply.type("text/html; charset=utf-8");
    if (req.headers["hx-request"] === "true") return list;
    const body = `<header class="page-head"><h1>${t(lang, "day.swap")} <time datetime="${date}">${date}</time></h1></header>\n${list}`;
    return page({ title: t(lang, "day.swap"), body, lang, tab: "plan" });
  });

  app.post<{ Body: SwapForm }>("/plan/swap", async (req, reply) => {
    const lang = langOf(req);
    const target = swapTarget(reply, lang, req.body.date);
    if (!target) return reply;
    const { date, plan } = target;
    const dishId = Number(req.body.dishId);
    if (!eligibleDishesOn(ctx.db, date).some((dish) => dish.id === dishId)) {
      return reply.code(400).type("text/plain; charset=utf-8").send(t(lang, "swap.notEligible"));
    }
    setPlannedDinnerDish(ctx.db, plan.id, date, dishId, t(lang, "swap.rationale"));
    const log = runLogger(ctx.log, req, "swap");
    log.info({ date, planId: plan.id, dishId, dish: getDish(ctx.db, dishId)?.name }, "dinner swapped");
    // The Shopping List follows the plan (FR-11). Sinks are not pushed; the next Plan Run or "Skicka igen" does that.
    await buildShoppingList({ db: ctx.db, llm: ctx.llm, fetchPage: ctx.fetchPage, now: ctx.now, log, language: lang }, plan.id);
    return reply.redirect(safeNext(req.body.next, date), 303);
  });
};
