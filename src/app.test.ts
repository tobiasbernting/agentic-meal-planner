import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { withEnglish } from "./i18n/test-helpers.js";
import { ScriptedLlmAgent } from "./llm/fake.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-app-"));
  const app = withEnglish(await buildApp({ dataDir }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("GET /", () => {
  it("serves an HTML page", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Meal Planner");
  });
});

describe("llm port", () => {
  it("defaults to the no-agent fallback when no agent_command is configured", async () => {
    vi.stubEnv("AGENT_COMMAND", "");
    const app = await start();

    expect(await app.ctx.llm.extractIngredients("page")).toEqual({ ok: false, reason: "no agent configured" });
  });

  it("uses the injected LlmAgent when one is given", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-app-"));
    const llm = new ScriptedLlmAgent({ extractIngredients: { ok: true, value: [{ name: "milk" }] } });
    const app = await buildApp({ dataDir, llm });
    apps.push(app);

    expect(await app.ctx.llm.extractIngredients("page")).toEqual({ ok: true, value: [{ name: "milk" }] });
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
