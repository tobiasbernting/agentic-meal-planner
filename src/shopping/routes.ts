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
import { householdToday, readTimezone } from "../planner/settings.js";
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
import { addLine, checkLine, clearLines, countChecked, deleteLine, moveLine, shoppingLineList, uncheckLine } from "./edits.js";
import { getListLines } from "./list.js";
import { SHOPPING_LIST_ID } from "../lists/schema.js";
import { getItem, getList } from "../lists/repo.js";
import { listActivity, listRecentlyCleared, recordActivity, rememberCleared, type Actor } from "../lists/activity.js";
import { activityDisclosure } from "../lists/view.js";
import { memberOf } from "../members/device.js";
import { createPantryItem, deletePantryItem, listPantryItems } from "../pantry/repo.js";
import { pantryLookup } from "../pantry/matching.js";
import { planRunBanner } from "../plan-run/routes.js";
import { addForm, clearControl, recentTray, renderLists, renderMissing, renderPlainLines, renderPushes, shortDate, type Undo } from "./view.js";

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
  /** Another shopping-style List; the Shopping List when absent. */
  listId?: string;
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
${recentTray(lang, SHOPPING_LIST_ID, listRecentlyCleared(ctx.db, SHOPPING_LIST_ID, ctx.now().toISOString()))}
${clearControl(lang, ctx)}
${renderPushes(lang, ctx, buy)}
${activityDisclosure(lang, listActivity(ctx.db, SHOPPING_LIST_ID, ctx.now().toISOString()), now, readTimezone(ctx.db))}`;
    html(reply);
    return page({ title: t(lang, "shopping.title"), body, lang, tab: "shopping" });
  });

  /** After an edit: the List's sections over HTMX, its page otherwise. */
  const sendLists = (req: FastifyRequest, reply: FastifyReply, undo?: Undo, listId = SHOPPING_LIST_ID) => {
    if (!isHtmx(req)) return reply.redirect(listId === SHOPPING_LIST_ID ? "/shopping" : `/lists/${listId}`, 303);
    html(reply);
    if (listId !== SHOPPING_LIST_ID) return reply.send(renderPlainLines(langOf(req), listId, getListLines(ctx.db, listId), readTimezone(ctx.db)));
    return reply.send(renderLists(langOf(req), ctx, { alwaysHome: true, undo }));
  };

  /** The device Member an edit is attributed to. */
  const actor = (req: FastifyRequest): Actor => {
    const me = memberOf(req, ctx.db);
    return me ? { id: me.id, name: me.name } : undefined;
  };

  /**
   * Applies a line edit, records it in the line's List's Activity, and answers for that List
   * (read before the edit, since Delete removes the line).
   */
  const lineEdit = (action: string, activity: "ticked" | "unticked" | "deleted", edit: (id: number, by: Actor, now: string) => boolean) =>
    app.post<{ Body: LineForm }>(action, async (req, reply) => {
      const id = lineId(req.body);
      const listId = id === undefined ? undefined : shoppingLineList(ctx.db, id);
      if (id !== undefined && listId !== undefined) {
        const item = getItem(ctx.db, id)!;
        const by = actor(req);
        const now = ctx.now().toISOString();
        if (edit(id, by, now)) {
          recordActivity(ctx.db, listId, activity, item.name, by, now);
          if (activity === "deleted") rememberCleared(ctx.db, listId, [{ name: item.name, quantity: item.quantity }], now);
        }
      }
      return sendLists(req, reply, undefined, listId ?? SHOPPING_LIST_ID);
    });
  lineEdit("/shopping/check", "ticked", (id, by, now) => checkLine(ctx.db, id, now, by?.name ?? null));
  lineEdit("/shopping/uncheck", "unticked", (id) => uncheckLine(ctx.db, id));
  lineEdit("/shopping/delete", "deleted", (id) => deleteLine(ctx.db, id));

  /** Hand-add (the add row, or a "Nyligen" chip): the line, its Activity row, back to its List. */
  const handAdd = (req: FastifyRequest, reply: FastifyReply, listId: number, body: AddForm) => {
    const name = body.name?.trim();
    if (name) {
      const now = ctx.now().toISOString();
      const line = addLine(ctx.db, { name, quantity: body.quantity }, now, listId);
      recordActivity(ctx.db, listId, "added", line.name, actor(req), now);
    }
    return reply.redirect(listId === SHOPPING_LIST_ID ? "/shopping" : `/lists/${listId}`, 303);
  };

  app.post<{ Body: AddForm }>("/shopping/add", async (req, reply) => {
    const requested = Number(req.body.listId);
    const listId = Number.isInteger(requested) && requested > 0 && getList(ctx.db, requested)?.kind === "shopping" ? requested : SHOPPING_LIST_ID;
    return handAdd(req, reply, listId, req.body);
  });

  app.post<{ Params: { id: string }; Body: AddForm }>("/lists/:id/add", async (req, reply) => {
    const list = getList(ctx.db, Number(req.params.id));
    if (!list || list.kind !== "shopping") return reply.code(404).type("text/plain; charset=utf-8").send(t(langOf(req), "lists.notFound"));
    return handAdd(req, reply, list.id, req.body);
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

  app.post("/shopping/clear", async (req, reply) => {
    const n = clearLines(ctx.db, SHOPPING_LIST_ID, actor(req), ctx.now().toISOString());
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
