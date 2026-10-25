import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDish } from "../dishes/repo.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { NoAgent } from "../llm/index.js";
import { createMember } from "../members/repo.js";
import { householdTick } from "../scheduler/household-tick.js";
import { lineIdOf, planWeek, sectionLines, updateList } from "../shopping/test-helpers.js";
import { listActivity, recordActivity } from "./activity.js";
import { SHOPPING_LIST_ID } from "./schema.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// Wednesday 2026-10-21 18:30 local time.
const NOW = new Date(2026, 9, 21, 18, 30);

type App = Awaited<ReturnType<typeof buildApp>>;

async function start() {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-activity-")), now: () => NOW, llm: new NoAgent() }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function get(app: App, url: string, cookie = "lang=en") {
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(res.statusCode, url).toBe(200);
  return res.body;
}

async function post(app: App, url: string, payload: Record<string, string>, cookie = "lang=en") {
  const res = await app.inject({ method: "POST", url, payload, headers: { cookie } });
  expect(res.statusCode, url).toBe(303);
  return res;
}

/** The Activity rows' text, in document order. */
function activity(html: string): string[] {
  const block = /<details class="activity">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  return [...block.matchAll(/<li class="row"><span class="row-status">([^<]*)<\/span><\/li>/g)].map((m) => m[1]!);
}

/** The "Nyligen" chips as [name, quantity]. */
function tray(html: string): [string, string | null][] {
  const block = /<section class="recent-tray"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  return [...block.matchAll(/<input type="hidden" name="name" value="([^"]*)" \/>(?:\s*<input type="hidden" name="quantity" value="([^"]*)" \/>)?/g)].map((m) => [m[1]!, m[2] ?? null]);
}

async function household() {
  const app = await start();
  const pappa = createMember(app.ctx.db, { name: "Pappa", colour: "moss" });
  const ikea = Number(/\/lists\/(\d+)$/.exec((await post(app, "/lists", { name: "Ikea", kind: "shopping" })).headers.location as string)![1]);
  return { app, pappa, cookie: `lang=en; member=${pappa.id}`, ikea };
}

describe("Activity", () => {
  it("records add, tick, untick, Delete and Clear on a shopping-style List with the device Member, newest first", async () => {
    const { app, cookie, ikea } = await household();
    await post(app, "/shopping/add", { name: "hyllor", quantity: "2", listId: String(ikea) }, cookie);
    await post(app, `/lists/${ikea}/add`, { name: "skruvar" });
    let html = await get(app, `/lists/${ikea}`);
    const hyllor = lineIdOf(html, "hyllor");
    const skruvar = lineIdOf(html, "skruvar");
    await post(app, "/shopping/check", { id: hyllor }, cookie);
    await post(app, "/shopping/uncheck", { id: hyllor }, cookie);
    await post(app, "/shopping/check", { id: hyllor }, cookie);
    await post(app, "/shopping/delete", { id: skruvar }, cookie);
    await post(app, `/lists/${ikea}/clear`, {}, cookie);

    html = await get(app, `/lists/${ikea}`);
    expect(html).toContain('<details class="activity">\n<summary>Activity</summary>');
    expect(activity(html)).toEqual([
      "Pappa cleared 1 line, 18:30",
      "Pappa deleted skruvar, 18:30",
      "Pappa ticked hyllor, 18:30",
      "Pappa un-ticked hyllor, 18:30",
      "Pappa ticked hyllor, 18:30",
      "Someone added skruvar, 18:30",
      "Pappa added hyllor, 18:30",
    ]);
    expect(activity(await get(app, `/lists/${ikea}`, `lang=sv; member=1`))[0]).toBe("Pappa rensade 1 rad, 18:30");
  });

  it("shows the ticking Member on a struck shopping-style line", async () => {
    const { app, cookie, ikea } = await household();
    await post(app, `/lists/${ikea}/add`, { name: "lampa" });
    await post(app, "/shopping/check", { id: lineIdOf(await get(app, `/lists/${ikea}`), "lampa") }, cookie);
    expect(await get(app, `/lists/${ikea}`)).toMatch(/<s class="row-label">lampa<\/s>\s*<span class="row-status line-done-by">Pappa wed 18:30<\/span>/);
  });

  it("records Todo add, tick, untick and Clear on a todo-style List", async () => {
    const { app, cookie } = await household();
    const chores = Number(/\/lists\/(\d+)$/.exec((await post(app, "/lists", { name: "Att göra", kind: "todo" })).headers.location as string)![1]);
    await post(app, `/lists/${chores}/todos`, { text: "Vattna blommorna" }, cookie);
    const id = /data-todo="(\d+)"/.exec(await get(app, `/lists/${chores}`))![1]!;
    await post(app, `/todos/${id}/tick`, {}, cookie);
    await post(app, `/todos/${id}/untick`, {}, cookie);
    await post(app, `/todos/${id}/tick`, {}, cookie);
    await post(app, `/lists/${chores}/clear`, {}, cookie);
    expect(activity(await get(app, `/lists/${chores}`, "lang=sv"))).toEqual([
      "Pappa rensade 1 rad, 18:30",
      "Pappa bockade av Vattna blommorna, 18:30",
      "Pappa ångrade Vattna blommorna, 18:30",
      "Pappa bockade av Vattna blommorna, 18:30",
      "Pappa lade till Vattna blommorna, 18:30",
    ]);
  });

  it("writes one summary row on the Shopping List for a Plan Run's update", async () => {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "ost", quantity: null, unit: null }] });
    const planId = planWeek(app.ctx.db, "2026-10-19", [pasta], NOW.toISOString());
    await updateList(app, planId);
    await updateList(app, planId);
    const rows = listActivity(app.ctx.db, SHOPPING_LIST_ID, NOW.toISOString());
    expect(rows.map((r) => [r.action, r.itemName, r.memberName])).toEqual([["planned", "2", null]]);
    expect(activity(await get(app, "/shopping", "lang=sv"))).toEqual(["Planeraren lade till 2 rader, 18:30"]);
  });

  it("dates older rows relative to today and leaves out rows older than 30 days, which the daily tick prunes", async () => {
    const { app, ikea } = await household();
    const db = app.ctx.db;
    recordActivity(db, ikea, "added", "igår", undefined, new Date(2026, 9, 20, 9, 5).toISOString());
    recordActivity(db, ikea, "added", "i måndags", undefined, new Date(2026, 9, 19, 9, 5).toISOString());
    recordActivity(db, ikea, "added", "förra veckan", undefined, new Date(2026, 9, 13, 9, 5).toISOString());
    recordActivity(db, ikea, "added", "gammalt", undefined, new Date(2026, 8, 10, 9, 5).toISOString());

    expect(activity(await get(app, `/lists/${ikea}`, "lang=sv"))).toEqual([
      "Någon lade till igår, igår 09:05",
      "Någon lade till i måndags, mån 09:05",
      "Någon lade till förra veckan, tis 13 okt 09:05",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity").get()).toEqual({ n: 4 });
    await householdTick({ db, now: () => NOW }, {});
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity").get()).toEqual({ n: 3 });
  });
});

describe("the re-add tray", () => {
  it("offers lines Cleared or Deleted, most recent first; a chip adds the line back and leaves the tray; a name on the list is not offered", async () => {
    const { app, ikea } = await household();
    for (const [name, quantity] of [["hyllor", "2"], ["skruvar", ""], ["lampa", ""]] as const) await post(app, `/lists/${ikea}/add`, { name, quantity });
    let html = await get(app, `/lists/${ikea}`);
    expect(tray(html)).toEqual([]);
    await post(app, "/shopping/check", { id: lineIdOf(html, "hyllor") });
    await post(app, `/lists/${ikea}/clear`, {});
    await post(app, "/shopping/delete", { id: lineIdOf(html, "skruvar") });

    html = await get(app, `/lists/${ikea}`, "lang=sv");
    expect(html).toContain(`<h2 class="section-label" id="recent-${ikea}">Nyligen</h2>`);
    expect(tray(html).sort()).toEqual([["hyllor", "2"], ["skruvar", null]]);
    expect(html).toContain(`<form method="post" action="/lists/${ikea}/add">`);

    await post(app, `/lists/${ikea}/add`, { name: "hyllor", quantity: "2" });
    html = await get(app, `/lists/${ikea}`);
    expect(sectionLines(html, "lines")).toEqual([["lampa", false], ["2 hyllor", false]]);
    expect(tray(html)).toEqual([["skruvar", null]]);

    // Typed back by hand, it is on the list, so the tray drops it too.
    await post(app, "/shopping/add", { name: "Skruvar", listId: String(ikea) });
    expect(tray(await get(app, `/lists/${ikea}`))).toEqual([]);
  });

  it("works on the Shopping List page too", async () => {
    const app = await start();
    await post(app, "/shopping/add", { name: "batterier" });
    await post(app, "/shopping/delete", { id: lineIdOf(await get(app, "/shopping"), "batterier") });
    const html = await get(app, "/shopping");
    expect(tray(html)).toEqual([["batterier", null]]);
    expect(html).toContain('<form method="post" action="/lists/1/add">');
    expect((await app.inject({ method: "POST", url: "/lists/999/add", payload: { name: "x" } })).statusCode).toBe(404);
  });
});
