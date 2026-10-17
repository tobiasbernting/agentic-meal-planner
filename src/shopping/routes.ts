/**
 * Shopping List view (FR-11, FR-17): the stored list for one week's Weekly Plan in two
 * sections, "Buy" and "Check pantry", with a rebuild action (page parts in ./view.ts). Building also happens
 * automatically after plan generation (src/plan/routes.ts and src/server.ts). The week's
 * Plan Run banner explains a half-built list; Build/Rebuild and Har alltid hemma are withheld
 * (and refused over HTTP) while that run is in flight. The household's own edits (ADR-0007:
 * check, uncheck, remove, restore, Extra Items) touch no list rows and are allowed any time.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FeaturePlugin } from "../app.js";
import { runLogger } from "../logging/logger.js";
import { resolveWeek } from "../week.js";
import { householdToday } from "../planner/settings.js";
import { getPlanForWeek } from "../planner/repo.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { getDish } from "../dishes/repo.js";
import { weekHead, weekNav } from "../ui/almanac.js";
import { isHtmx, navigate } from "../ui/htmx.js";
import { notice, page } from "../ui/layout.js";
import { pushShoppingList } from "../sinks/push.js";
import { buildShoppingList, getMissingDishIds, getShoppingList } from "./build.js";
import { addExtraItem, checkLine, deleteExtraItem, removeLine, restoreLine, uncheckLine } from "./edits.js";
import { createPantryItem, deletePantryItem, listPantryItems } from "../pantry/repo.js";
import { pantryLookup } from "../pantry/matching.js";
import { planRunBanner } from "../plan-run/routes.js";
import { buildForm, renderLists, renderMissing, renderPushes, type Undo } from "./view.js";

interface ShoppingQuery {
  week?: string;
  notice?: string;
}

const NOTICES = { "run-in-progress": "shopping.notice.run-in-progress" } as const;

function queryNotice(lang: Lang, key: string | undefined): string {
  return key !== undefined && Object.hasOwn(NOTICES, key) ? notice({ text: t(lang, NOTICES[key as keyof typeof NOTICES]), role: "status" }) : "";
}

/** Where a refused change returns: the week's list with the run-in-progress notice. */
function runInProgress(weekStart: string): string {
  return `/shopping?week=${weekStart}&notice=run-in-progress`;
}

interface BuildForm {
  weekStart?: string;
}

interface PantryForm extends BuildForm {
  name?: string;
}

interface UndoForm extends BuildForm {
  id?: string;
}

/** Every week edit posts at least the week. */
interface WeekForm {
  weekStart?: string;
}

/** Check, uncheck, remove and restore post the week and the line's name. */
interface LineForm {
  weekStart?: string;
  name?: string;
}

/** Extra Item add posts the week, the item's name and an optional free-text quantity. */
interface ExtraForm extends LineForm {
  quantity?: string;
}

/** Extra Item delete posts the week and the item's id. */
interface ExtraDeleteForm {
  weekStart?: string;
  id?: string;
}

export const shoppingRoutes: FeaturePlugin = async (app, ctx) => {
  const rebuildDeps = (req: FastifyRequest) => ({ ...ctx, log: runLogger(ctx.log, req, "shopping"), language: langOf(req) });

  app.get<{ Querystring: ShoppingQuery }>("/shopping", async (req, reply) => {
    const lang = langOf(req);
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    const runInFlight = ctx.planRuns.isInFlight(weekStart);
    const dishName = (id: number) => getDish(ctx.db, id)?.name;
    /** The Build or Rebuild form, or nothing while the week's Plan Run is in flight. */
    const rebuild = (label: string) => (runInFlight ? "" : buildForm(weekStart, label));
    let content: string;
    if (!plan) {
      content = `<p class="notice">${t(lang, "shopping.noPlan")} <a href="/plan?week=${weekStart}">${t(lang, "shopping.goToPlan")}</a> ${t(lang, "shopping.toGenerate")}</p>`;
    } else {
      const { buy, checkPantry, removed } = getShoppingList(ctx.db, plan.id);
      const missing = renderMissing(lang, weekStart, getMissingDishIds(ctx.db, plan.id).flatMap((id) => dishName(id) ?? []), !runInFlight);
      content =
        buy.length + checkPantry.length + removed.length === 0
          ? `${missing}<p class="notice">${t(lang, "shopping.none")}</p>
${rebuild(t(lang, "shopping.build"))}`
          : `${missing}
${renderLists(lang, ctx, plan.id, weekStart, { alwaysHome: !runInFlight })}
${rebuild(t(lang, "shopping.rebuild"))}
${renderPushes(lang, ctx, plan.id, weekStart, buy)}`;
    }
    const body = `${weekHead(lang, weekStart)}
${weekNav(lang, weekStart, "/shopping")}
${queryNotice(lang, req.query.notice)}
${planRunBanner(ctx, lang, weekStart)}
${content}`;
    reply.type("text/html; charset=utf-8");
    return page({ title: t(lang, "shopping.title"), body, lang, tab: "shopping" });
  });

  // Build, Försök igen and Har alltid hemma rewrite the list the week's Plan Run is also writing, so all are refused in flight.
  app.post<{ Body: BuildForm }>("/shopping/build", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(runInProgress(weekStart), 303);
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) {
      const deps = rebuildDeps(req);
      await buildShoppingList(deps, plan.id);
      await pushShoppingList(deps, plan.id);
    }
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  // Försök igen: re-resolves only the Dishes the last build recorded as missing, past their caches
  // (a cached empty list included). It does not push: the household sends with Skicka igen.
  app.post<{ Body: BuildForm }>("/shopping/retry", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return reply.redirect(runInProgress(weekStart), 303);
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await buildShoppingList(rebuildDeps(req), plan.id, new Set(getMissingDishIds(ctx.db, plan.id)));
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });

  /** A refused change: the week's list with the run-in-progress notice. */
  const refuse = (req: FastifyRequest, reply: FastifyReply, weekStart: string) => navigate(req, reply, runInProgress(weekStart));
  const sendLists = (req: FastifyRequest, reply: FastifyReply, weekStart: string, undo?: Undo) => {
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (!isHtmx(req) || !plan) return reply.redirect(`/shopping?week=${weekStart}`, 303);
    reply.type("text/html; charset=utf-8");
    return reply.send(renderLists(langOf(req), ctx, plan.id, weekStart, { alwaysHome: true, undo }));
  };

  app.post<{ Body: PantryForm }>("/shopping/pantry", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return refuse(req, reply, weekStart);
    const name = req.body.name?.trim();
    let undo: Undo | undefined;
    if (name) {
      const existing = pantryLookup(listPantryItems(ctx.db))(name);
      // Ångra only removes an item this tap created.
      if (!existing) undo = createPantryItem(ctx.db, { name, aliases: [] });
      const plan = getPlanForWeek(ctx.db, weekStart);
      if (plan) await buildShoppingList(rebuildDeps(req), plan.id);
    }
    return sendLists(req, reply, weekStart, undo);
  });

  app.post<{ Body: UndoForm }>("/shopping/pantry/undo", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    if (ctx.planRuns.isInFlight(weekStart)) return refuse(req, reply, weekStart);
    const id = Number(req.body.id);
    if (Number.isInteger(id)) {
      deletePantryItem(ctx.db, id);
      const plan = getPlanForWeek(ctx.db, weekStart);
      if (plan) await buildShoppingList(rebuildDeps(req), plan.id);
    }
    return sendLists(req, reply, weekStart);
  });

  app.get<{ Querystring: ShoppingQuery }>("/shopping/sections", async (req, reply) => {
    const weekStart = resolveWeek(req.query.week, householdToday(ctx.db, ctx.now()));
    return sendLists(req, reply, weekStart);
  });

  // The week's own edits (ADR-0007): plain POST forms, each back to the week's page.
  /** Resolves the posted week, applies the edit to it, and redirects back to the week's list. */
  const weekEdit = <Form extends WeekForm>(action: string, edit: (weekStart: string, form: Form) => void) => {
    app.post<{ Body: WeekForm }>(action, async (req, reply) => {
      const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
      edit(weekStart, req.body as Form);
      return reply.redirect(`/shopping?week=${weekStart}`, 303);
    });
  };
  const lineEdit = (action: string, edit: (weekStart: string, name: string) => void) =>
    weekEdit<LineForm>(action, (weekStart, form) => {
      const name = form.name?.trim();
      if (name) edit(weekStart, name);
    });
  lineEdit("/shopping/check", (weekStart, name) => checkLine(ctx.db, weekStart, name));
  lineEdit("/shopping/uncheck", (weekStart, name) => uncheckLine(ctx.db, weekStart, name));
  lineEdit("/shopping/remove", (weekStart, name) => removeLine(ctx.db, weekStart, name));
  lineEdit("/shopping/restore", (weekStart, name) => restoreLine(ctx.db, weekStart, name));

  weekEdit<ExtraForm>("/shopping/extra", (weekStart, form) => {
    const name = form.name?.trim();
    if (name) addExtraItem(ctx.db, weekStart, { name, quantity: form.quantity });
  });

  weekEdit<ExtraDeleteForm>("/shopping/extra/delete", (weekStart, form) => {
    const id = Number(form.id);
    if (Number.isInteger(id)) deleteExtraItem(ctx.db, weekStart, id);
  });

  app.post<{ Body: BuildForm }>("/shopping/push", async (req, reply) => {
    const weekStart = resolveWeek(req.body.weekStart, householdToday(ctx.db, ctx.now()));
    const plan = getPlanForWeek(ctx.db, weekStart);
    if (plan) await pushShoppingList({ ...ctx, log: runLogger(ctx.log, req, "shopping") }, plan.id);
    return reply.redirect(`/shopping?week=${weekStart}`, 303);
  });
};
