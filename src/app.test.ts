import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { withEnglish } from "./i18n/test-helpers.js";
import { ScriptedLlmAgent } from "./llm/fake.js";
import { createCapturingLogger } from "./logging/logger.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-app-"));
  const app = withEnglish(await buildApp({ dataDir }));
  apps.push(app);
  return app;
}

async function startLogged() {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-app-"));
  const { logger, records } = createCapturingLogger();
  const app = withEnglish(await buildApp({ dataDir, logger }));
  apps.push(app);
  return { app, records, dataDir };
}

/** A temp executable named `name`; returns its absolute path. */
function fakeAgentBinary(name = "fakeagent"): string {
  const dir = mkdtempSync(join(tmpdir(), "mp-bin-"));
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

afterEach(async () => {
  vi.unstubAllEnvs();
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
  it("reports ok and no agent when none is configured", async () => {
    vi.stubEnv("AGENT_COMMAND", "");
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", agentBinaryFound: false, agentCommand: null });
  });

  it("reports whether the agent binary is found on PATH", async () => {
    const bin = fakeAgentBinary("fakeagent");
    vi.stubEnv("PATH", `${join(bin, "..")}:/nonexistent`);
    vi.stubEnv("AGENT_COMMAND", "fakeagent -p");
    const app = await start();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", agentBinaryFound: true, agentCommand: "fakeagent -p" });

    vi.stubEnv("AGENT_COMMAND", "no-such-agent-xyz -p");
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      status: "ok",
      agentBinaryFound: false,
      agentCommand: "no-such-agent-xyz -p",
    });
  });
});

describe("logging", () => {
  it("logs a startup record with what the server resolved", async () => {
    const bin = fakeAgentBinary("fakeagent");
    vi.stubEnv("PATH", join(bin, ".."));
    vi.stubEnv("AGENT_COMMAND", "fakeagent -p");
    vi.stubEnv("TZ", "Europe/Stockholm");
    const { records, dataDir } = await startLogged();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "startup",
        agentCommand: "fakeagent -p",
        agentBinaryFound: true,
        tz: "Europe/Stockholm",
        dataDir,
        cronExpression: "0 18 * * 0",
      }),
    );
    expect(records.filter((r) => r.level === "warn")).toEqual([]);
  });

  it("warns at startup when the agent binary is not on PATH", async () => {
    vi.stubEnv("PATH", "/nonexistent");
    vi.stubEnv("AGENT_COMMAND", "copilot -p");
    const { records } = await startLogged();

    expect(records).toContainEqual(expect.objectContaining({ level: "warn", agentBinary: "copilot", agentBinaryFound: false }));
  });

  it("logs every HTTP request with its request id as runId", async () => {
    const { app, records } = await startLogged();

    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/" });

    const completed = records.filter((r) => r.msg === "request completed");
    expect(completed).toEqual([
      expect.objectContaining({ level: "info", url: "/health", statusCode: 200, runId: expect.any(String) }),
      expect.objectContaining({ level: "info", url: "/", statusCode: 200, runId: expect.any(String) }),
    ]);
    expect(completed[0]!.runId).not.toBe(completed[1]!.runId);
    const incoming = records.filter((r) => r.msg === "incoming request");
    expect(incoming.map((r) => r.runId)).toEqual(completed.map((r) => r.runId));
  });
});

describe("agent call logging", () => {
  it("routes the configured agent's records through the app logger under component llm", async () => {
    vi.stubEnv("AGENT_COMMAND", "mp-no-such-agent-binary -p");
    const { app, records } = await startLogged();

    const res = await app.inject({
      method: "POST",
      url: "/dishes",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "name=Pannkakor",
    });

    expect(res.statusCode).toBe(303);
    expect(records.find((r) => r.level === "warn" && r.operation === "suggestMainCategory")).toMatchObject({
      component: "llm",
      cause: "not-found",
      reason: "agent binary not found: mp-no-such-agent-binary",
    });
  });
});
