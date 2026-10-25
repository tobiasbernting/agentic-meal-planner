import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent } from "../llm/index.js";
import { createMember } from "../members/repo.js";
import { planWeek, sectionLines, updateList } from "../shopping/test-helpers.js";
import { listLists } from "./repo.js";
import { listDoneRecords, listTodos } from "./todos.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// Wednesday 2026-10-21 18:30; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-lists-")), now: () => NOW, llm: new NoAgent(), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = Awaited<ReturnType<typeof buildApp>>;

async function get(app: App, url: string, cookie?: string) {
  const res = await app.inject({ method: "GET", url, ...(cookie ? { headers: { cookie } } : {}) });
  expect(res.statusCode, url).toBe(200);
  return res.body;
}

async function post(app: App, url: string, payload: Record<string, string>, cookie?: string) {
  const res = await app.inject({ method: "POST", url, payload, ...(cookie ? { headers: { cookie } } : {}) });
  expect(res.statusCode, url).toBe(303);
  return res;
}

/** The Listor rows as [href, label, status]. */
function listRows(html: string): [string, string, string][] {
  return [...html.matchAll(/<a class="row-link" href="([^"]+)"><span class="row-label">([^<]*)<\/span><span class="row-status">([^<]*)<\/span><\/a>/g)].map((m) => [m[1]!, m[2]!, m[3]!]);
}

/** The Todo rows as [title, done, overdue], in document order. */
function todoRows(html: string): [string, boolean, boolean][] {
  return [...html.matchAll(/<li class="row todo([^"]*)" data-todo="\d+">[\s\S]*?<(?:span|s) class="row-label">([^<]*)<\/(?:span|s)>/g)].map((m) => [m[2]!, m[1]!.includes("todo-done"), m[1]!.includes("todo-overdue")]);
}

function todoId(html: string, title: string): string {
  const m = new RegExp(`<li class="row todo[^"]*" data-todo="(\\d+)">[\\s\\S]*?class="row-label">${title}<`).exec(html);
  if (!m) throw new Error(`no todo ${title}`);
  return m[1]!;
}

async function createList(app: App, name: string, kind: "todo" | "shopping"): Promise<number> {
  const res = await post(app, "/lists", { name, kind });
  return Number(/\/lists\/(\d+)$/.exec(res.headers.location as string)![1]);
}

describe("Listor", () => {
  it("lists the Shopping List first with its open count, then the household's Lists in order with their kind and count", async () => {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    await updateList(app, planWeek(app.ctx.db, WEEK, [pasta], NOW.toISOString()));
    const chores = await createList(app, "Att göra", "todo");
    const ikea = await createList(app, "Ikea", "shopping");
    await post(app, `/lists/${chores}/todos`, { title: "Vattna blommorna" });
    await post(app, "/shopping/add", { name: "hyllor", listId: String(ikea) });

    const html = await get(app, "/lists");

    expect(listRows(html)).toEqual([
      ["/shopping", "Shopping List", "shopping · 2 open"],
      [`/lists/${chores}`, "Att göra", "todo · 1 open"],
      [`/lists/${ikea}`, "Ikea", "shopping · 1 open"],
    ]);
    expect(html).toMatch(/<nav class="tabbar"[^>]*>[\s\S]*<a href="\/lists" aria-current="page">Lists<\/a>/);
  });

  it("creates, renames, reorders and deletes a List; the Shopping List cannot be deleted and redirects to its own page", async () => {
    const app = await start();
    const a = await createList(app, "A", "todo");
    const b = await createList(app, "B", "todo");
    expect((await app.inject({ method: "POST", url: "/lists", payload: { name: "", kind: "todo" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/lists", payload: { name: "X", kind: "board" } })).statusCode).toBe(400);

    await post(app, `/lists/${a}`, { name: "Alpha" });
    await post(app, `/lists/${b}/move`, { direction: "up" });
    expect(listLists(app.ctx.db).map((l) => l.name)).toEqual(["Shopping List", "B", "Alpha"]);

    const confirm = await get(app, `/lists/${a}/delete`);
    expect(confirm).toContain("Alpha has 0 open and will be deleted with everything on it.");
    await post(app, `/lists/${a}/delete`, {});
    expect(listLists(app.ctx.db).map((l) => l.name)).toEqual(["Shopping List", "B"]);

    expect((await app.inject({ method: "GET", url: "/lists/1/delete" })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/lists/1/delete" })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/lists/1" })).headers.location).toBe("/shopping");
    expect((await app.inject({ method: "GET", url: "/lists/999" })).statusCode).toBe(404);
  });
});

describe("a shopping-style List", () => {
  it("has the Shopping page's line behaviour: tick, untick, Delete, Clear and hand-add, with no sections and no Har alltid hemma", async () => {
    const app = await start();
    const ikea = await createList(app, "Ikea", "shopping");

    await post(app, "/shopping/add", { name: "hyllor", quantity: "2", listId: String(ikea) });
    await post(app, "/shopping/add", { name: "skruvar", listId: String(ikea) });
    let html = await get(app, `/lists/${ikea}`);
    expect(html).toContain('<div id="shopping-lists" data-list="' + ikea + '">');
    expect(html).toMatch(/<section id="lines"><ul class="rows">/);
    expect(html).not.toContain('id="buy"');
    expect(html).not.toContain("/shopping/pantry");
    expect(sectionLines(html, "lines")).toEqual([["2 hyllor", false], ["skruvar", false]]);
    const hyllor = /data-line="(\d+)" data-name="hyllor"/.exec(html)![1]!;

    const ticked = await app.inject({ method: "POST", url: "/shopping/check", payload: { id: hyllor } });
    expect(ticked.headers.location).toBe(`/lists/${ikea}`);
    html = await get(app, `/lists/${ikea}`);
    expect(sectionLines(html, "lines")).toEqual([["skruvar", false], ["2 hyllor", true]]);
    expect(html).toContain(`<a class="button quiet" href="/lists/${ikea}/clear">Clear checked (1)</a>`);

    const fragment = await app.inject({ method: "POST", url: "/shopping/uncheck", headers: { "hx-request": "true" }, payload: { id: hyllor } });
    expect(fragment.body).toMatch(/^<div id="shopping-lists" data-list="\d+">/);
    await post(app, "/shopping/check", { id: hyllor });

    expect(await get(app, `/lists/${ikea}/clear`)).toContain("1 done lines will be removed from Ikea.");
    const cleared = await post(app, `/lists/${ikea}/clear`, {});
    expect(cleared.headers.location).toBe(`/lists/${ikea}?cleared=1`);
    html = await get(app, `/lists/${ikea}?cleared=1`);
    expect(html).toContain("1 done lines cleared.");
    expect(sectionLines(html, "lines")).toEqual([["skruvar", false]]);

    await post(app, "/shopping/delete", { id: /data-line="(\d+)" data-name="skruvar"/.exec(html)![1]! });
    expect(await get(app, `/lists/${ikea}`)).toContain("Nothing on this list yet.");
    expect(sectionLines(await get(app, "/shopping"), "buy")).toEqual([]);
  });
});

describe("a todo-style List", () => {
  async function withChores(options: Partial<AppOptions> = {}) {
    const app = await start(options);
    const pappa = createMember(app.ctx.db, { name: "Pappa", colour: "moss" });
    const ella = createMember(app.ctx.db, { name: "Ella", colour: "berry" });
    const chores = await createList(app, "Att göra", "todo");
    return { app, pappa, ella, chores };
  }

  it("adds Todos with and without Due and Member, sorts by Due with undated last, and marks overdue ones", async () => {
    const { app, ella, chores } = await withChores();

    await post(app, `/lists/${chores}/todos`, { title: "Boka tandläkare", due_date: "2026-10-23", due_time: "15:00", member: String(ella.id) });
    await post(app, `/lists/${chores}/todos`, { title: "Vattna blommorna" });
    await post(app, `/lists/${chores}/todos`, { title: "Lämna paket", due_date: "2026-10-20" });
    expect((await app.inject({ method: "POST", url: `/lists/${chores}/todos`, payload: { title: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/lists/${chores}/todos`, payload: { title: "x", due_date: "nonsense" } })).statusCode).toBe(400);

    const html = await get(app, `/lists/${chores}`);
    expect(todoRows(html)).toEqual([["Lämna paket", false, true], ["Boka tandläkare", false, false], ["Vattna blommorna", false, false]]);
    expect(html).toMatch(/Boka tandläkare<\/span>\s*<div class="todo-meta"><span class="todo-due">fri 23 Oct 15:00<\/span><span class="member-chip member-berry"><span class="member-dot" aria-hidden="true"><\/span>Ella<\/span><\/div>/);
    expect(html).toMatch(/<span class="todo-overdue-mark">Overdue<\/span><span class="todo-due">tue 20 Oct<\/span>/);
    const sv = await get(app, `/lists/${chores}`, "lang=sv");
    expect(sv).toContain("Försenad");
    expect(sv).toContain("fre 23 okt 15:00");
  });

  it("tick strikes and sorts below with the device Member's name, untick restores, Clear removes Done, and HTMX answers with the row", async () => {
    const { app, pappa, chores } = await withChores();
    const cookie = `lang=en; member=${pappa.id}`;
    await post(app, `/lists/${chores}/todos`, { title: "Vattna blommorna" });
    await post(app, `/lists/${chores}/todos`, { title: "Lämna paket" });
    let html = await get(app, `/lists/${chores}`);
    const vattna = todoId(html, "Vattna blommorna");

    const ticked = await post(app, `/todos/${vattna}/tick`, {}, cookie);
    expect(ticked.headers.location).toBe(`/lists/${chores}`);
    html = await get(app, `/lists/${chores}`);
    expect(todoRows(html)).toEqual([["Lämna paket", false, false], ["Vattna blommorna", true, false]]);
    expect(html).toMatch(/<s class="row-label">Vattna blommorna<\/s>\s*<div class="todo-meta"><span class="todo-done-by">Pappa wed 18:30<\/span><\/div>/);
    expect(html).toContain(`href="/lists/${chores}/clear">Clear done (1)</a>`);

    const fragment = await app.inject({ method: "POST", url: `/todos/${vattna}/untick`, headers: { "hx-request": "true" }, payload: {} });
    expect(fragment.statusCode).toBe(200);
    expect(fragment.body).toMatch(/^<li class="row todo" data-todo="\d+">/);
    expect(fragment.body).toContain(`action="/todos/${vattna}/tick"`);
    expect(todoRows(await get(app, `/lists/${chores}`))).toEqual([["Vattna blommorna", false, false], ["Lämna paket", false, false]]);

    await post(app, `/todos/${vattna}/tick`, { next: "/" });
    expect((await app.inject({ method: "POST", url: `/todos/${vattna}/tick`, payload: { next: "/" } })).headers.location).toBe("/");
    expect(await get(app, `/lists/${chores}/clear`)).toContain("1 done lines will be removed from Att göra.");
    const cleared = await post(app, `/lists/${chores}/clear`, {});
    expect(cleared.headers.location).toBe(`/lists/${chores}?cleared=1`);
    expect(todoRows(await get(app, `/lists/${chores}`))).toEqual([["Lämna paket", false, false]]);
  });

  it("edits title, notes, Due and Member, and deletes", async () => {
    const { app, ella, chores } = await withChores();
    await post(app, `/lists/${chores}/todos`, { title: "Boka tandläkare" });
    const id = todoId(await get(app, `/lists/${chores}`), "Boka tandläkare");

    const editPage = await get(app, `/todos/${id}/edit`);
    expect(editPage).toMatch(/<input name="title" required value="Boka tandläkare"/);
    expect(editPage).toContain('name="repeat_kind"');
    await post(app, `/todos/${id}`, { title: "Boka tandläkare för Ella", notes: "Folktandvården", due_date: "2026-11-03", due_time: "09:30", member: String(ella.id) });

    const html = await get(app, `/lists/${chores}`);
    expect(html).toContain("Boka tandläkare för Ella");
    expect(html).toContain("tue 3 Nov 09:30");
    expect(html).toContain(">Ella</span>");
    expect(await get(app, `/todos/${id}/edit`)).toContain(">Folktandvården</textarea>");

    await post(app, `/todos/${id}/delete`, {});
    expect(await get(app, `/lists/${chores}`)).toContain("Nothing on this list yet.");
    expect((await app.inject({ method: "GET", url: `/todos/${id}/edit` })).statusCode).toBe(404);
  });

  it("filters to the device Member's Todos with Mina, and hides the toggle without a device Member", async () => {
    const { app, pappa, ella, chores } = await withChores();
    await post(app, `/lists/${chores}/todos`, { title: "Pappas grej", member: String(pappa.id) });
    await post(app, `/lists/${chores}/todos`, { title: "Ellas grej", member: String(ella.id) });
    await post(app, `/lists/${chores}/todos`, { title: "Allas grej" });

    const anonymous = await get(app, `/lists/${chores}`);
    const mine = await get(app, `/lists/${chores}?mine=1`, `lang=en; member=${pappa.id}`);
    const all = await get(app, `/lists/${chores}`, `lang=en; member=${pappa.id}`);

    expect(anonymous).not.toContain('class="list-filter');
    expect(todoRows(mine).map(([title]) => title)).toEqual(["Pappas grej"]);
    expect(mine).toMatch(/<a class="button" href="\/lists\/\d+\?mine=1" aria-current="true">Mine<\/a>/);
    expect(todoRows(all).map(([title]) => title)).toEqual(["Pappas grej", "Ellas grej", "Allas grej"]);
  });

  it("a repeating Todo advances its Due on tick, records who did it, is never struck, refuses untick, and can end its Repeat", async () => {
    const { app, pappa, chores } = await withChores();
    const cookie = `lang=en; member=${pappa.id}`;
    await post(app, `/lists/${chores}/todos`, { title: "Soptunnan ut", due_date: "2026-10-21" });
    const id = todoId(await get(app, `/lists/${chores}`), "Soptunnan ut");
    expect((await app.inject({ method: "POST", url: `/todos/${id}`, payload: { title: "Soptunnan ut", due_date: "2026-10-21", repeat_kind: "weekly" } })).statusCode).toBe(400);
    await post(app, `/todos/${id}`, { title: "Soptunnan ut", due_date: "2026-10-21", repeat_kind: "weekly", repeat_weekdays: "wed" });

    let html = await get(app, `/lists/${chores}`);
    expect(html).toContain("↻ every wednesday");
    const ticked = await app.inject({ method: "POST", url: `/todos/${id}/tick`, headers: { "hx-request": "true", cookie }, payload: {} });

    expect(ticked.body).toMatch(/^<li class="row todo" data-todo="\d+">/);
    expect(ticked.body).toContain('<span class="todo-flash" role="status">Done, next wed 28 Oct</span>');
    expect(ticked.body).toContain("wed 28 Oct");
    html = await get(app, `/lists/${chores}`);
    expect(todoRows(html)).toEqual([["Soptunnan ut", false, false]]);
    expect(listTodos(app.ctx.db, chores)[0]!.dueDate).toBe("2026-10-28");
    expect(listDoneRecords(app.ctx.db, Number(id)).map((d) => d.memberName)).toEqual(["Pappa"]);
    expect((await app.inject({ method: "POST", url: `/todos/${id}/untick`, payload: {} })).statusCode).toBe(409);
    const edit = await get(app, `/todos/${id}/edit`);
    expect(edit).toContain("Done before");
    expect(edit).toContain("Pappa wed 18:30");
    expect(edit).toContain('name="repeat_kind"');
    expect(edit).toMatch(/<option value="weekly" selected>/);

    await post(app, `/todos/${id}/repeat/end`, {});
    expect(listTodos(app.ctx.db, chores)[0]!.repeat).toBeNull();
    expect(await get(app, `/lists/${chores}`)).not.toContain("↻");
    const sv = await get(app, `/todos/${id}/edit`, "lang=sv");
    expect(sv).toContain("Upprepas inte");
  });

  it("a repeating Todo without a Due anchors on today and shows the repeat only with a Due", async () => {
    const { app, chores } = await withChores();
    await post(app, `/lists/${chores}/todos`, { title: "Dammsuga" });
    const id = todoId(await get(app, `/lists/${chores}`), "Dammsuga");
    const edit = await get(app, `/todos/${id}/edit`);
    expect(edit).toContain("Set a due date to repeat.");

    await post(app, `/todos/${id}`, { title: "Dammsuga", repeat_kind: "daily" });
    expect(listTodos(app.ctx.db, chores)[0]!.repeat).toBeNull();
    await post(app, `/todos/${id}`, { title: "Dammsuga", due_date: "2026-10-21", repeat_kind: "every_n_weeks", repeat_n: "2" });
    expect(await get(app, `/lists/${chores}`, "lang=sv")).toContain("↻ varannan vecka");
  });
});
