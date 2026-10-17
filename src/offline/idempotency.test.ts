import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];

async function start(options: Partial<AppOptions> = {}) {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-idempotency-")), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function post(app: App, url: string, payload: Record<string, string>, key?: string) {
  return app.inject({ method: "POST", url, payload, ...(key ? { headers: { "idempotency-key": key } } : {}) });
}

async function pantryNames(app: App) {
  const res = await app.inject({ method: "GET", url: "/pantry" });
  return [...res.body.matchAll(/<span class="row-label">([^<]*)<\/span>/g)].map((m) => m[1]);
}

describe("Idempotency-Key on queueable routes", () => {
  it("applies a Pantry Item create once and returns the same redirect for a repeated key", async () => {
    const app = await start();

    const first = await post(app, "/pantry", { name: "milk", aliases: "" }, "key-1");
    const second = await post(app, "/pantry", { name: "milk", aliases: "" }, "key-1");

    expect(first.statusCode).toBe(303);
    expect(second.statusCode).toBe(303);
    expect(second.headers.location).toBe("/pantry");
    expect(second.headers.location).toBe(first.headers.location);
    expect(await pantryNames(app)).toEqual(["milk"]);
  });
});
