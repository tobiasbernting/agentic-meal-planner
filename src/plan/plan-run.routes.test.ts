import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { ScriptedLlmAgent, type LlmResult, type SelectedDish } from "../llm/index.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-plan-run-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** A promise the test resolves when it wants the held agent call to answer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Plan Run started from the Plan page", () => {
  it("redirects to the Plan page before the agent has answered and shows the run in progress", async () => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const llm = new ScriptedLlmAgent({ selectDishes: () => held.promise });
    const app = await start({ llm });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    const res = await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body).toContain("Plan Run in progress since 18:30");
    expect(view.body).toContain("Dish selection");
    held.resolve({ ok: false, reason: "released" });
  });
});
