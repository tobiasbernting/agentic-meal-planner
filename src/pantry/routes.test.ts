import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-pantry-http-")) });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function createItem(app: Awaited<ReturnType<typeof buildApp>>, name: string, aliases: string) {
  return app.inject({ method: "POST", url: "/pantry", payload: { name, aliases } });
}

describe("Pantry pages", () => {
  it("links to Pantry from the nav, after Schools", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toContain('<a href="/schools">Schools</a> <a href="/pantry">Pantry</a>');
  });

  it("creates a Pantry Item with comma-separated aliases and lists it", async () => {
    const app = await start();

    const created = await createItem(app, "milk", "mjölk, whole milk");
    const list = await app.inject({ method: "GET", url: "/pantry" });

    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe("/pantry");
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("milk");
    expect(list.body).toContain("mjölk, whole milk");
  });

  it("rejects a Pantry Item without a name", async () => {
    const app = await start();

    const res = await createItem(app, "  ", "mjölk");
    const list = await app.inject({ method: "GET", url: "/pantry" });

    expect(res.statusCode).toBe(400);
    expect(list.body).not.toContain("mjölk");
  });

  it("edits a Pantry Item's name and aliases", async () => {
    const app = await start();
    await createItem(app, "milk", "mjölk");

    const editPage = await app.inject({ method: "GET", url: "/pantry/1/edit" });
    const updated = await app.inject({ method: "POST", url: "/pantry/1", payload: { name: "oat milk", aliases: "havremjölk" } });
    const list = await app.inject({ method: "GET", url: "/pantry" });

    expect(editPage.statusCode).toBe(200);
    expect(editPage.body).toContain('value="milk"');
    expect(editPage.body).toContain('value="mjölk"');
    expect(updated.statusCode).toBe(303);
    expect(list.body).toContain("oat milk");
    expect(list.body).toContain("havremjölk");
    expect(list.body).not.toContain(">mjölk<");
  });

  it("removes a Pantry Item", async () => {
    const app = await start();
    await createItem(app, "milk", "mjölk");

    const deleted = await app.inject({ method: "POST", url: "/pantry/1/delete" });
    const list = await app.inject({ method: "GET", url: "/pantry" });

    expect(deleted.statusCode).toBe(303);
    expect(list.body).not.toContain("mjölk");
  });

  it("returns 404 for an unknown Pantry Item", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/pantry/99/edit" });

    expect(res.statusCode).toBe(404);
  });
});
