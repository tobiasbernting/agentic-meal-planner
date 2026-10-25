import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDish } from "../dishes/repo.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createList } from "../lists/repo.js";
import { createTodo, getTodo, type TodoInput } from "../lists/todos.js";
import { NoAgent } from "../llm/index.js";
import { createMember } from "../members/repo.js";
import { savePlan } from "../planner/repo.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// Wednesday 2026-10-21 18:30; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const TODAY = "2026-10-21";
const TOMORROW = "2026-10-22";

type App = Awaited<ReturnType<typeof buildApp>>;

async function start() {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-almanac-todos-")), now: () => NOW, llm: new NoAgent() }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function row(body: string, date: string): string {
  const m = body.match(new RegExp(`<article[^>]*id="day-${date}"[\\s\\S]*?</article>`));
  if (!m) throw new Error(`no row for ${date}`);
  return m[0];
}

/** Todo titles in document order. */
function titles(html: string): string[] {
  return [...html.matchAll(/<li class="row todo[^"]*" data-todo="\d+">[\s\S]*?class="row-label">([^<]*)</g)].map((m) => m[1]!);
}

async function household() {
  const app = await start();
  const db = app.ctx.db;
  const pappa = createMember(db, { name: "Pappa", colour: "moss" });
  const ella = createMember(db, { name: "Ella", colour: "berry" });
  const chores = createList(db, "Att göra", "todo", NOW.toISOString());
  const add = (input: TodoInput) => createTodo(db, chores.id, input, NOW.toISOString(), null);
  const pasta = createDish(db, { name: "Pasta pesto" });
  savePlan(db, { weekStart: "2026-10-19", dinners: [{ date: TODAY, dishId: pasta, isQuickDay: false, lunchThatDay: null, rationale: "" }], degradedReasons: [] }, NOW.toISOString());
  return { app, db, pappa, ella, chores, add };
}

describe("Today carries the Todos", () => {
  it("lists overdue Todos first under Overdue, then today's, with the Member chip in text; a day with none shows nothing extra", async () => {
    const { app, ella, add } = await household();
    add({ title: "Hämta paket", dueDate: "2026-10-19" });
    add({ title: "Boka tandläkare", dueDate: TODAY, dueTime: "15:00", member: { id: ella.id, name: ella.name } });
    add({ title: "Vattna blommorna", dueDate: TODAY });
    add({ title: "Undated", dueDate: null });

    const body = (await app.inject({ method: "GET", url: "/" })).body;
    const today = row(body, TODAY);
    expect(titles(today)).toEqual(["Hämta paket", "Boka tandläkare", "Vattna blommorna"]);
    expect(today).toMatch(/<div class="label">Overdue<\/div><ul class="rows day-todos">[\s\S]*Hämta paket[\s\S]*<div class="label">To do<\/div>/);
    expect(today.indexOf("Pasta pesto")).toBeGreaterThan(-1);
    expect(today.indexOf("Pasta pesto")).toBeLessThan(today.indexOf("Hämta paket"));
    expect(today).toContain('<span class="member-chip member-berry"><span class="member-dot" aria-hidden="true"></span>Ella</span>');
    expect(today).toContain('<span class="todo-list">Att göra</span>');
    // The overdue Todo is not repeated on its own past row.
    expect(row(body, "2026-10-19")).not.toContain("todo");
    expect(row(body, "2026-10-23")).not.toContain("todo");
    expect(body).not.toContain("Undated");

    const sv = (await app.inject({ method: "GET", url: "/", headers: { cookie: "lang=sv" } })).body;
    expect(row(sv, TODAY)).toContain('<div class="label">Försenat</div>');
    expect(row(sv, TODAY)).toContain('<div class="label">Att göra</div>');
  });

  it("shows tomorrow's Todos at half density with +N more, and later days as a count", async () => {
    const { app, add } = await household();
    for (const title of ["Ett", "Två", "Tre", "Fyra", "Fem"]) add({ title, dueDate: TOMORROW });
    add({ title: "Lördag", dueDate: "2026-10-24" });

    const body = (await app.inject({ method: "GET", url: "/" })).body;
    expect(titles(row(body, TOMORROW))).toEqual(["Ett", "Två", "Tre"]);
    expect(row(body, TOMORROW)).toContain('<div class="day-todos-more muted">+2 more</div>');
    expect(row(body, "2026-10-24")).toContain('<div class="day-todos-count">1 to do</div>');
    const sv = (await app.inject({ method: "GET", url: "/", headers: { cookie: "lang=sv" } })).body;
    expect(row(sv, TOMORROW)).toContain("+2 till");
    expect(row(sv, "2026-10-24")).toContain("1 att göra");
  });

  it("ticks from Today and stays on Today, by redirect and over HTMX", async () => {
    const { app, add } = await household();
    const todo = add({ title: "Vattna blommorna", dueDate: TODAY });

    const body = (await app.inject({ method: "GET", url: "/" })).body;
    expect(row(body, TODAY)).toContain('<input type="hidden" name="next" value="/" />');

    const redirect = await app.inject({ method: "POST", url: `/todos/${todo.id}/tick`, payload: { next: "/" } });
    expect(redirect.statusCode).toBe(303);
    expect(redirect.headers.location).toBe("/");
    expect(getTodo(app.ctx.db, todo.id)!.doneAt).not.toBeNull();
    expect(titles(row((await app.inject({ method: "GET", url: "/" })).body, TODAY))).toEqual([]);

    const fragment = await app.inject({ method: "POST", url: `/todos/${todo.id}/untick`, headers: { "hx-request": "true" }, payload: { next: "/" } });
    expect(fragment.statusCode).toBe(200);
    expect(fragment.body).toMatch(/^<li class="row todo" data-todo="\d+">/);
    expect(fragment.body).toContain('<input type="hidden" name="next" value="/" />');
    expect(fragment.body).toContain('<span class="todo-list">Att göra</span>');
  });

  it("mine=1 keeps the device Member's Todos and the lunch and Dinner; the toggle needs a device Member", async () => {
    const { app, pappa, ella, add } = await household();
    add({ title: "Pappas grej", dueDate: TODAY, member: { id: pappa.id, name: pappa.name } });
    add({ title: "Ellas grej", dueDate: TODAY, member: { id: ella.id, name: ella.name } });

    const anonymous = (await app.inject({ method: "GET", url: "/?mine=1" })).body;
    expect(anonymous).not.toContain('href="/?mine=1"');
    expect(titles(row(anonymous, TODAY))).toEqual(["Pappas grej", "Ellas grej"]);

    const cookie = `lang=en; member=${pappa.id}`;
    const all = (await app.inject({ method: "GET", url: "/", headers: { cookie } })).body;
    expect(all).toContain('<a class="button" href="/?mine=1">Mine</a>');
    const mine = (await app.inject({ method: "GET", url: "/?mine=1", headers: { cookie } })).body;
    expect(mine).toContain('<a class="button" href="/?mine=1" aria-current="true">Mine</a>');
    expect(titles(row(mine, TODAY))).toEqual(["Pappas grej"]);
    expect(row(mine, TODAY)).toContain("Pasta pesto");
    expect(row(mine, TODAY)).toContain('<input type="hidden" name="next" value="/?mine=1" />');
  });
});

describe("Plan carries the Todos", () => {
  it("lists each day's Todos on its row, ticking back to the Plan week", async () => {
    const { app, add } = await household();
    add({ title: "Soptunnan ut", dueDate: "2026-10-21" });
    add({ title: "Packa gympapåsen", dueDate: "2026-10-23" });

    const body = (await app.inject({ method: "GET", url: "/plan?week=2026-10-19" })).body;
    expect(titles(row(body, "2026-10-21"))).toEqual(["Soptunnan ut"]);
    expect(titles(row(body, "2026-10-23"))).toEqual(["Packa gympapåsen"]);
    expect(row(body, "2026-10-22")).not.toContain("day-todos");
    expect(row(body, "2026-10-23")).toContain('<input type="hidden" name="next" value="/plan?week=2026-10-19" />');
  });
});
