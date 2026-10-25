/**
 * The Shopping List page (FR-11, FR-17, ADR-0009): the household's one living list in two
 * sections, "Buy" and "Check pantry" (page parts in ./view.ts). The Plan Run's Shopping List
 * update adds Shares to it (src/shopping/shares.ts, called from the plan routes, the weekly
 * run and Swap); the page itself never rebuilds anything. The household's edits (tick, hand-add,
 * Delete, Clear, Har alltid hemma) touch lines only, need no Plan Run, and are allowed any time. Försök igen
 * re-resolves the dinners with no Ingredients and is withheld (and refused) while their week's
 * Plan Run is in flight.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FeaturePlugin } from "../app.js";
import { runLogger } from "../logging/logger.js";
import { householdToday } from "../planner/settings.js";
import { getPlanById } from "../planner/repo.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { getDish } from "../dishes/repo.js";
import { weekHead } from "../ui/almanac.js";
import { isHtmx, navigate } from "../ui/htmx.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { pushShoppingList } from "../sinks/push.js";
import { addDays, mondayOf } from "../week.js";
import { getShoppingList } from "./list.js";
import { listMissingDinners, updateShoppingList } from "./shares.js";
import { addLine, checkLine, clearChecked, countChecked, deleteLine, moveLine, uncheckLine } from "./edits.js";
import { createPantryItem, deletePantryItem, listPantryItems } from "../pantry/repo.js";
import { pantryLookup } from "../pantry/matching.js";
import { planRunBanner } from "../plan-run/routes.js";
import { addForm, clearControl, renderLists, renderMissing, renderPushes, shortDate, type Undo } from "./view.js";

interface ShoppingQuery {
  notice?: string;
  cleared?: string;
}

/** Edits post the line's id. */
interface LineForm {
  id?: string;
}

interface AddForm {
  name?: string;
  quantity?: string;
}

interface PantryForm extends LineForm {
  name?: string;
}

interface UndoForm extends LineForm {
  pantryId?: string;
}

function queryNotice(lang: Lang, query: ShoppingQuery): string {
  if (query.notice === "run-in-progress") return notice({ text: t(lang, "shopping.notice.run-in-progress"), role: "status" });
  const cleared = Number(query.cleared);
  if (Number.isInteger(cleared) && cleared > 0) return notice({ text: t(lang, "shopping.cleared", { n: cleared }), role: "status" });
  return "";
}

function lineId(form: LineForm): number | undefined {
  const id = Number(form.id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  const today = () => householdToday(ctx.db, ctx.now());
  const html = (reply: FastifyReply) => reply.type("text/html; charset=utf-8");

  /** The weeks whose Plan Run would also write the dinners with no Ingredients. */
  const missingWeeks = () => new Set(listMissingDinners(ctx.db).flatMap((d) => getPlanById(ctx.db, d.planId)?.weekStart ?? []));
  const retryBlocked = () => [...missingWeeks()].some((week) => ctx.planRuns.isInFlight(week));

  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const lang = langOf(req);
    const now = today();
    const thisWeek = mondayOf(now);
    const { buy, checkPantry } = getShoppingList(ctx.db);
    const missingNames = listMissingDinners(ctx.db).flatMap(({ dishId, date }) => {
      const name = getDish(ctx.db, dishId)?.name;
      return name ? [`${name} (${shortDate(lang, date)})`] : [];
    });
    const empty = buy.length + checkPantry.length === 0;
    const body = `${weekHead(lang, now)}
${queryNotice(lang, req.query)}
${planRunBanner(ctx, lang, thisWeek)}
${planRunBanner(ctx, lang, addDays(thisWeek, 7))}
${renderMissing(lang, missingNames, !retryBlocked())}
${empty ? `<p class="notice">${t(lang, "shopping.empty")} <a href="/plan">${t(lang, "shopping.goToPlan")}</a></p>` : renderLists(lang, ctx)}
${addForm(lang, ctx)}
${clearControl(lang, ctx)}
${renderPushes(lang, ctx, buy)}`;
    html(reply);
    return page({ title: t(lang, "shopping.title"), body, lang, tab: "shopping" });
  });

  /** After an edit: the sections over HTMX, the page otherwise. */
  const sendLists = (req: FastifyRequest, reply: FastifyReply, undo?: Undo) => {
    if (!isHtmx(req)) return reply.redirect("/shopping", 303);
    html(reply);
    return reply.send(renderLists(langOf(req), ctx, { alwaysHome: true, undo }));
  };

  app.post<{ Body: LineForm }>("/shopping/check", async (req, reply) => {
    const id = lineId(req.body);
    if (id !== undefined) checkLine(ctx.db, id, ctx.now().toISOString());
    return sendLists(req, reply);
  });

  app.post<{ Body: LineForm }>("/shopping/uncheck", async (req, reply) => {
    const id = lineId(req.body);
    if (id !== undefined) uncheckLine(ctx.db, id);
    return sendLists(req, reply);
  });

  app.post<{ Body: LineForm }>("/shopping/delete", async (req, reply) => {
    const id = lineId(req.body);
    if (id !== undefined) deleteLine(ctx.db, id);
    return sendLists(req, reply);
  });

  app.post<{ Body: AddForm }>("/shopping/add", async (req, reply) => {
    const name = req.body.name?.trim();
    if (name) addLine(ctx.db, { name, quantity: req.body.quantity }, ctx.now().toISOString());
    return reply.redirect("/shopping", 303);
  });

  // Clear asks once: the GET is the confirmation page, the POST removes every Checked Off line.
  app.get("/shopping/clear", async (req, reply) => {
    const lang = langOf(req);
    const n = countChecked(ctx.db);
    const body = `<header class="page-head"><h1>${t(lang, "shopping.clearTitle")}</h1></header>
<p>${escapeHtml(t(lang, "shopping.clearText", { n }))}</p>
<form method="post" action="/shopping/clear">
  <button type="submit" class="primary">${escapeHtml(t(lang, "shopping.clearConfirm", { n }))}</button>
</form>
<p><a href="/shopping">${t(lang, "shopping.clearCancel")}</a></p>`;
    html(reply);
    return page({ title: t(lang, "shopping.clearTitle"), body, lang, tab: "shopping" });
  });

  app.post("/shopping/clear", async (_req, reply) => {
    const n = clearChecked(ctx.db);
    return reply.redirect(n > 0 ? `/shopping?cleared=${n}` : "/shopping", 303);
  });

  // Försök igen: re-resolves only the dinners with no Ingredients, past their caches. It does not push.
  app.post("/shopping/retry", async (req, reply) => {
    if (retryBlocked()) return navigate(req, reply, "/shopping?notice=run-in-progress");
    const missing = listMissingDinners(ctx.db);
    const byPlan = new Map<number, Set<number>>();
    for (const d of missing) (byPlan.get(d.planId) ?? byPlan.set(d.planId, new Set()).get(d.planId)!).add(d.id);
    const deps = { ...ctx, log: runLogger(ctx.log, req, "shopping"), language: langOf(req) };
    for (const [planId, dinnerIds] of byPlan) await updateShoppingList(deps, planId, dinnerIds);
    return reply.redirect("/shopping", 303);
  });

  /** Har alltid hemma: a Pantry Item of the line's name (unless one matches already), and the line moves to Check pantry. */
  app.post<{ Body: PantryForm }>("/shopping/pantry", async (req, reply) => {
    const id = lineId(req.body);
    const name = req.body.name?.trim();
    if (id === undefined || !name) return sendLists(req, reply);
    const existing = pantryLookup(listPantryItems(ctx.db))(name);
    // Ångra only removes an item this tap created.
    const undo: Undo = existing ? { lineId: id } : { lineId: id, pantryId: createPantryItem(ctx.db, { name, aliases: [] }).id };
    moveLine(ctx.db, id, "check_pantry");
    return sendLists(req, reply, undo);
  });

  app.post<{ Body: UndoForm }>("/shopping/pantry/undo", async (req, reply) => {
    const id = lineId(req.body);
    const pantryId = Number(req.body.pantryId);
    if (Number.isInteger(pantryId) && pantryId > 0) deletePantryItem(ctx.db, pantryId);
    if (id !== undefined) moveLine(ctx.db, id, "buy");
    return sendLists(req, reply);
  });

  app.get("/shopping/sections", async (req, reply) => sendLists(req, reply));

  app.post("/shopping/push", async (req, reply) => {
    await pushShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") });
    return reply.redirect("/shopping", 303);
  });
};
