import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { MEMBER_COLOURS } from "./palette.js";
import { createMember, listMembers } from "./repo.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-members-")) }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = Awaited<ReturnType<typeof buildApp>>;

const add = (app: App, name: string, colour: string, topic = "") => app.inject({ method: "POST", url: "/members", payload: { name, colour, topic } });

describe("Members", () => {
  it("creates, lists, edits and deletes Members, and Mer counts them", async () => {
    const app = await start();

    const created = await add(app, "Pappa", "moss", "pappa-reminders");
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe("/members");
    await add(app, "Ella", "berry");

    const list = (await app.inject({ method: "GET", url: "/members" })).body;
    expect(list).toContain('<span class="member-chip member-moss"><span class="member-dot" aria-hidden="true"></span>Pappa</span>');
    expect(list).toContain("member-berry");
    expect(list).toContain("pappa-reminders");
    expect((await app.inject({ method: "GET", url: "/more" })).body).toContain("2 members");

    const edited = await app.inject({ method: "POST", url: "/members/1", payload: { name: "Dad", colour: "sea", topic: "" } });
    expect(edited.statusCode).toBe(303);
    expect(listMembers(app.ctx.db).map((m) => [m.name, m.colour, m.topic])).toEqual([["Dad", "sea", null], ["Ella", "berry", null]]);

    await app.inject({ method: "POST", url: "/members/2/delete" });
    expect(listMembers(app.ctx.db).map((m) => m.name)).toEqual(["Dad"]);
  });

  it("offers exactly the palette as labelled swatches and refuses a Member without a name or with a colour outside it", async () => {
    const app = await start();

    const html = (await app.inject({ method: "GET", url: "/members" })).body;
    const swatches = [...html.matchAll(/<label class="chip swatch member-(\w+)"><input type="radio" name="colour" value="(\w+)"[^>]*> <span class="member-dot" aria-hidden="true"><\/span>([^<]+)<\/label>/g)];
    expect(swatches.map((m) => m[2])).toEqual([...MEMBER_COLOURS]);
    expect(swatches.map((m) => m[3])).toEqual(["Moss", "Sea", "Plum", "Clay", "Sand", "Slate", "Berry", "Pine"]);
    expect(html).not.toMatch(/value="red"/);

    expect((await add(app, "  ", "moss")).statusCode).toBe(400);
    expect((await add(app, "Pappa", "red")).statusCode).toBe(400);
    expect(listMembers(app.ctx.db)).toEqual([]);
    const sv = (await app.inject({ method: "GET", url: "/members", headers: { cookie: "lang=sv" } })).body;
    expect(sv).toContain("Mossa");
  });

  it("picks the next free colour for the add form", async () => {
    const app = await start();
    createMember(app.ctx.db, { name: "A", colour: "moss" });
    createMember(app.ctx.db, { name: "B", colour: "sea" });

    const html = (await app.inject({ method: "GET", url: "/members" })).body;

    expect(html).toMatch(/name="colour" value="plum" checked/);
  });
});

describe("the device Member", () => {
  it("POST /me sets the cookie for a year, GET /me shows the choice, and Mer names the phone", async () => {
    const app = await start();
    const pappa = createMember(app.ctx.db, { name: "Pappa", colour: "moss" });

    const chosen = await app.inject({ method: "POST", url: "/me", payload: { member: String(pappa.id), next: "/lists" } });

    expect(chosen.statusCode).toBe(303);
    expect(chosen.headers.location).toBe("/lists");
    expect(chosen.headers["set-cookie"]).toMatch(/^member=1; Path=\/; Max-Age=31536000; SameSite=Lax$/);
    const me = (await app.inject({ method: "GET", url: "/me", headers: { cookie: "lang=en; member=1" } })).body;
    expect(me).toMatch(/name="member" value="1" checked/);
    expect(me).toContain("Whose phone is this?");
    const more = (await app.inject({ method: "GET", url: "/more", headers: { cookie: "lang=en; member=1" } })).body;
    expect(more).toContain("1 member · This phone: Pappa");
  });

  it("clears the cookie for no one, refuses an unknown Member, and reads a deleted Member as no one", async () => {
    const app = await start();
    const pappa = createMember(app.ctx.db, { name: "Pappa", colour: "moss" });

    const cleared = await app.inject({ method: "POST", url: "/me", payload: { member: "" } });
    expect(cleared.headers["set-cookie"]).toMatch(/^member=; Path=\/; Max-Age=0/);
    expect(cleared.headers.location).toBe("/more");
    expect((await app.inject({ method: "POST", url: "/me", payload: { member: "99" } })).statusCode).toBe(400);

    await app.inject({ method: "POST", url: `/members/${pappa.id}/delete`, headers: { cookie: `member=${pappa.id}` } });
    const me = (await app.inject({ method: "GET", url: "/me", headers: { cookie: `lang=en; member=${pappa.id}` } })).body;
    expect(me).toMatch(/name="member" value="" checked/);
    const more = (await app.inject({ method: "GET", url: "/more", headers: { cookie: `lang=en; member=${pappa.id}` } })).body;
    expect(more).toContain("Whose phone is this?");
  });

  it("links to the chooser from Members when the device has none, and offers to add Members when there are none", async () => {
    const app = await start();

    const me = (await app.inject({ method: "GET", url: "/me" })).body;
    const members = (await app.inject({ method: "GET", url: "/members" })).body;

    expect(me).toContain('href="/members"');
    expect(members).toContain('<a class="button quiet" href="/me">Whose phone is this?</a>');
  });
});
