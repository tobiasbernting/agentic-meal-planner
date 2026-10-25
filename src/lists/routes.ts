/**
 * Lists and Todos (ADR-0010): the Listor tab, List CRUD, shopping-style List pages reusing the
 * Shopping page's line parts, and todo-style List pages with Todos, Done, Clear, Repeat and the
 * Mina filter. The Shopping List (id 1) keeps its own page at /shopping.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FeaturePlugin } from "../app.js";
import { isWeekday, WEEKDAYS, type Weekday } from "../dishes/repo.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { memberOf } from "../members/device.js";
import { getMember, listMembers } from "../members/repo.js";
import { householdToday, readTimezone } from "../planner/settings.js";
import { countChecked } from "../shopping/edits.js";
import { getListLines } from "../shopping/list.js";
import { addForm, clearControl, renderPlainLines, shortDate } from "../shopping/view.js";
import { isHtmx } from "../ui/htmx.js";
import { page } from "../ui/layout.js";
import { countOpenItems, createList, deleteList, getList, listLists, moveList, renameList, type List, type ListKind } from "./repo.js";
import { SHOPPING_LIST_ID } from "./schema.js";
import { isRepeatKind, type RepeatRule } from "./repeat.js";
import { clearDoneTodos, createTodo, deleteTodo, endRepeat, getTodo, listDoneRecords, listTodos, tickTodo, untickTodo, updateTodo, type TodoInput } from "./todos.js";
import { listClearPage, listDeletePage, listEditPage, listHead, listHref, listName, listsPage, todoEditPage, todoListPage, todoRow } from "./view.js";

interface ListParams {
  id: string;
}

interface ListForm {
  name?: string;
  kind?: string;
}

interface MoveForm {
  direction?: string;
}

interface TodoForm {
  title?: string;
  notes?: string;
  due_date?: string;
  due_time?: string;
  member?: string;
  repeat_kind?: string;
  repeat_weekdays?: string | string[];
  repeat_n?: string;
  repeat_day?: string;
  next?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function isKind(value: unknown): value is ListKind {
  return value === "shopping" || value === "todo";
}

/** A same-origin relative path ("/x"), else undefined. */
function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return undefined;
  return value;
}

function parseRepeat(body: TodoForm): RepeatRule | null | "invalid" {
  const kind = body.repeat_kind;
  if (!kind || kind === "none") return null;
  if (!isRepeatKind(kind)) return "invalid";
  switch (kind) {
    case "daily":
    case "weekdays":
    case "yearly":
      return { kind };
    case "weekly": {
      const raw = body.repeat_weekdays === undefined ? [] : [body.repeat_weekdays].flat();
      const weekdays: Weekday[] = WEEKDAYS.filter((d) => raw.includes(d));
      return weekdays.length && raw.every(isWeekday) ? { kind, weekdays } : "invalid";
    }
    case "every_n_weeks": {
      const n = Number(body.repeat_n);
      return Number.isInteger(n) && n >= 2 ? { kind, n } : "invalid";
    }
    case "monthly": {
      const day = Number(body.repeat_day);
      return Number.isInteger(day) && day >= 1 && day <= 31 ? { kind, day } : "invalid";
    }
  }
}

export const listRoutes: FeaturePlugin = async (app, ctx) => {
  const { db } = ctx;
  const html = (reply: FastifyReply) => reply.type("text/html; charset=utf-8");
  const today = () => householdToday(db, ctx.now());

  /** The posted Todo fields as a TodoInput, or an error key. */
  function parseTodoForm(lang: Lang, body: TodoForm): TodoInput | { error: string } {
    const title = body.title?.trim() ?? "";
    if (!title) return { error: t(lang, "todo.invalid") };
    const dueDate = body.due_date?.trim() || null;
    if (dueDate && !ISO_DATE.test(dueDate)) return { error: t(lang, "todo.invalidDate") };
    const dueTime = body.due_time?.trim() || null;
    if (dueTime && !HH_MM.test(dueTime)) return { error: t(lang, "todo.invalidTime") };
    const memberId = Number(body.member);
    const member = body.member && Number.isInteger(memberId) ? getMember(db, memberId) : undefined;
    const repeat = dueDate ? parseRepeat(body) : null;
    if (repeat === "invalid") return { error: t(lang, "todo.repeat.invalid") };
    return { title, notes: body.notes ?? null, dueDate, dueTime: dueDate ? dueTime : null, member: member ? { id: member.id, name: member.name } : null, repeat };
  }

  const notFound = (req: FastifyRequest, reply: FastifyReply, key: "lists.notFound" | "todo.notFound") => reply.code(404).type("text/plain; charset=utf-8").send(t(langOf(req), key));

  app.get("/lists", async (req, reply) => {
    html(reply);
    return listsPage(langOf(req), ctx, listLists(db));
  });

  app.post<{ Body: ListForm }>("/lists", async (req, reply) => {
    const name = req.body?.name?.trim() ?? "";
    const kind = req.body?.kind;
    if (!name || !isKind(kind)) {
      html(reply.code(400));
      return listsPage(langOf(req), ctx, listLists(db), t(langOf(req), "lists.invalid"));
    }
    const list = createList(db, name, kind, ctx.now().toISOString());
    return reply.redirect(`/lists/${list.id}`, 303);
  });

  app.get<{ Params: ListParams; Querystring: { mine?: string; cleared?: string } }>("/lists/:id", async (req, reply) => {
    const lang = langOf(req);
    const list = getList(db, Number(req.params.id));
    if (!list) return notFound(req, reply, "lists.notFound");
    if (list.id === SHOPPING_LIST_ID) return reply.redirect("/shopping", 303);
    html(reply);
    const cleared = Number(req.query.cleared);
    const clearedNotice = Number.isInteger(cleared) && cleared > 0 ? t(lang, "lists.cleared", { n: cleared }) : undefined;
    if (list.kind === "shopping") {
      const lines = getListLines(db, list.id);
      const body = `${listHead(lang, list)}
${clearedNotice ? `<div class="notice" role="status"><span class="notice-text">${clearedNotice}</span></div>` : ""}
${lines.length === 0 ? `<p class="notice">${t(lang, "lists.empty")}</p>` : renderPlainLines(lang, list.id, lines)}
${addForm(lang, ctx, list.id)}
${clearControl(lang, ctx, list.id)}`;
      return page({ title: list.name, body, lang, tab: "lists" });
    }
    const me = memberOf(req, db);
    const todos = listTodos(db, list.id);
    return todoListPage(lang, ctx, list, todos, {
      today: today(),
      timezone: readTimezone(db),
      me,
      mine: req.query.mine === "1",
      doneCount: todos.filter((todo) => todo.doneAt !== null).length,
      ...(clearedNotice ? { notice: clearedNotice } : {}),
    });
  });

  app.get<{ Params: ListParams }>("/lists/:id/edit", async (req, reply) => {
    const list = getList(db, Number(req.params.id));
    if (!list) return notFound(req, reply, "lists.notFound");
    html(reply);
    return listEditPage(langOf(req), list, listLists(db));
  });

  app.post<{ Params: ListParams; Body: ListForm }>("/lists/:id", async (req, reply) => {
    const list = getList(db, Number(req.params.id));
    if (!list) return notFound(req, reply, "lists.notFound");
    const name = req.body?.name?.trim() ?? "";
    if (!name) {
      html(reply.code(400));
      return listEditPage(langOf(req), list, listLists(db), t(langOf(req), "lists.invalid"));
    }
    renameList(db, list.id, name);
    return reply.redirect(listHref(list), 303);
  });

  app.post<{ Params: ListParams; Body: MoveForm }>("/lists/:id/move", async (req, reply) => {
    const id = Number(req.params.id);
    const direction = req.body?.direction;
    if (direction === "up" || direction === "down") moveList(db, id, direction);
    return reply.redirect(`/lists/${id}/edit`, 303);
  });

  app.get<{ Params: ListParams }>("/lists/:id/delete", async (req, reply) => {
    const list = getList(db, Number(req.params.id));
    if (!list) return notFound(req, reply, "lists.notFound");
    if (list.id === SHOPPING_LIST_ID) return reply.code(409).type("text/plain; charset=utf-8").send(t(langOf(req), "lists.cannotDelete"));
    html(reply);
    return listDeletePage(langOf(req), ctx, list);
  });

  app.post<{ Params: ListParams }>("/lists/:id/delete", async (req, reply) => {
    const id = Number(req.params.id);
    if (id === SHOPPING_LIST_ID) return reply.code(409).type("text/plain; charset=utf-8").send(t(langOf(req), "lists.cannotDelete"));
    deleteList(db, id);
    return reply.redirect("/lists", 303);
  });

  // Clear on any List but the Shopping List, which has its own at /shopping/clear.
  app.get<{ Params: ListParams }>("/lists/:id/clear", async (req, reply) => {
    const list = getList(db, Number(req.params.id));
    if (!list) return notFound(req, reply, "lists.notFound");
    if (list.id === SHOPPING_LIST_ID) return reply.redirect("/shopping/clear", 303);
    html(reply);
    return listClearPage(langOf(req), list, countChecked(db, list.id));
  });

  app.post<{ Params: ListParams }>("/lists/:id/clear", async (req, reply) => {
    const list = getList(db, Number(req.params.id));
    if (!list) return notFound(req, reply, "lists.notFound");
    if (list.id === SHOPPING_LIST_ID) return reply.redirect("/shopping/clear", 303);
    const n = clearDoneTodos(db, list.id);
    return reply.redirect(n > 0 ? `/lists/${list.id}?cleared=${n}` : `/lists/${list.id}`, 303);
  });

  // Todos.
  app.post<{ Params: ListParams; Body: TodoForm }>("/lists/:id/todos", async (req, reply) => {
    const lang = langOf(req);
    const list = getList(db, Number(req.params.id));
    if (!list || list.kind !== "todo") return notFound(req, reply, "lists.notFound");
    const parsed = parseTodoForm(lang, req.body ?? {});
    if ("error" in parsed) {
      html(reply.code(400));
      const todos = listTodos(db, list.id);
      return todoListPage(lang, ctx, list, todos, { today: today(), timezone: readTimezone(db), me: memberOf(req, db), mine: false, doneCount: todos.filter((todo) => todo.doneAt !== null).length, notice: parsed.error });
    }
    createTodo(db, list.id, parsed, ctx.now().toISOString(), memberOf(req, db)?.name ?? null);
    return reply.redirect(`/lists/${list.id}`, 303);
  });

  app.get<{ Params: ListParams }>("/todos/:id/edit", async (req, reply) => {
    const todo = getTodo(db, Number(req.params.id));
    const list = todo && getList(db, todo.listId);
    if (!todo || !list) return notFound(req, reply, "todo.notFound");
    html(reply);
    return todoEditPage(langOf(req), ctx, list, todo, listDoneRecords(db, todo.id));
  });

  app.post<{ Params: ListParams; Body: TodoForm }>("/todos/:id", async (req, reply) => {
    const lang = langOf(req);
    const todo = getTodo(db, Number(req.params.id));
    const list = todo && getList(db, todo.listId);
    if (!todo || !list) return notFound(req, reply, "todo.notFound");
    const parsed = parseTodoForm(lang, req.body ?? {});
    if ("error" in parsed) {
      html(reply.code(400));
      return todoEditPage(lang, ctx, list, todo, listDoneRecords(db, todo.id), parsed.error);
    }
    updateTodo(db, todo.id, parsed);
    return reply.redirect(listHref(list), 303);
  });

  app.post<{ Params: ListParams; Body: TodoForm }>("/todos/:id/delete", async (req, reply) => {
    const todo = getTodo(db, Number(req.params.id));
    if (todo) deleteTodo(db, todo.id);
    return reply.redirect(todo ? `/lists/${todo.listId}` : "/lists", 303);
  });

  /** After a tick: the row over HTMX, else back to `next` or the List. */
  const answerTick = (req: FastifyRequest, reply: FastifyReply, id: number, listId: number, flash?: string) => {
    const next = safePath(req.body && typeof req.body === "object" ? (req.body as TodoForm).next : undefined) ?? `/lists/${listId}`;
    if (!isHtmx(req)) return reply.redirect(next, 303);
    const todo = getTodo(db, id);
    html(reply);
    if (!todo) return reply.send("");
    const list = getList(db, listId);
    return reply.send(todoRow(langOf(req), todo, listMembers(db), { today: today(), timezone: readTimezone(db), next, ...(flash ? { flash } : {}), ...(next.startsWith("/lists/") ? {} : { listName: list ? listName(langOf(req), list) : undefined }) }));
  };

  app.post<{ Params: ListParams; Body: TodoForm }>("/todos/:id/tick", async (req, reply) => {
    const lang = langOf(req);
    const todo = getTodo(db, Number(req.params.id));
    if (!todo) return notFound(req, reply, "todo.notFound");
    const me = memberOf(req, db);
    const outcome = tickTodo(db, todo.id, ctx.now().toISOString(), today(), me ? { id: me.id, name: me.name } : undefined);
    const flash = outcome.kind === "advanced" ? t(lang, "todo.repeat.advanced", { date: shortDate(lang, outcome.nextDue) }) : undefined;
    return answerTick(req, reply, todo.id, todo.listId, flash);
  });

  app.post<{ Params: ListParams; Body: TodoForm }>("/todos/:id/untick", async (req, reply) => {
    const todo = getTodo(db, Number(req.params.id));
    if (!todo) return notFound(req, reply, "todo.notFound");
    if (!untickTodo(db, todo.id)) return reply.code(409).type("text/plain; charset=utf-8").send(t(langOf(req), "todo.repeat.cannotUntick"));
    return answerTick(req, reply, todo.id, todo.listId);
  });

  app.post<{ Params: ListParams }>("/todos/:id/repeat/end", async (req, reply) => {
    const todo = getTodo(db, Number(req.params.id));
    if (!todo) return notFound(req, reply, "todo.notFound");
    endRepeat(db, todo.id);
    return reply.redirect(`/todos/${todo.id}/edit`, 303);
  });
};

