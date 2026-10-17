import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

/** An app on the real pino logger; its "stdout" lines are collected in `stdout`. */
async function start(options: Partial<AppOptions> = {}) {
  const stdout: Record<string, unknown>[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "mp-logs-"));
  const app = withEnglish(
    await buildApp({ dataDir, logLevel: "info", logDestination: { write: (line: string) => void stdout.push(JSON.parse(line)) }, ...options }),
  );
  apps.push(app);
  return { app, stdout };
}

/** The JSON records of an SSE body (`data: <json>` events). */
function sseRecords(body: string): Record<string, unknown>[] {
  return body
    .split("\n\n")
    .filter((event) => event.startsWith("data: "))
    .map((event) => JSON.parse(event.slice("data: ".length)));
}

/** Reads SSE records off a live stream until one matches. */
async function nextRecord(stream: Readable, match: (r: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    const found = sseRecords(text).find(match);
    if (found) return found;
  }
  throw new Error("stream ended without a matching record");
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("GET /logs/stream", () => {
  it("replays the buffered records as server-sent events, in the same shape as stdout", async () => {
    const { app, stdout } = await start();
    await app.inject({ method: "GET", url: "/health" });

    const res = await app.inject({ method: "GET", url: "/logs/stream?once=1" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    const records = sseRecords(res.body);
    const health = records.find((r) => r.msg === "request completed" && r.url === "/health");
    expect(health).toMatchObject({ level: 30, statusCode: 200, runId: expect.any(String) });
    expect(stdout).toContainEqual(health);
    expect(records.find((r) => r.msg === "startup")).toMatchObject({ component: "startup" });
  });

  it("pushes a record logged after the client connected", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "GET", url: "/logs/stream", payloadAsStream: true });
    const stream = res.stream();

    const pending = nextRecord(stream, (r) => r.msg === "request completed" && r.url === "/health");
    await app.inject({ method: "GET", url: "/health" });

    expect(await pending).toMatchObject({ statusCode: 200 });
    stream.destroy();
  });
});

describe("POST /logs/level", () => {
  it("switches the live level, including for loggers created before the switch", async () => {
    const { app, stdout } = await start({ logLevel: "info" });
    const probe = app.ctx.log.child({ component: "probe" });
    probe.debug({}, "before");

    const res = await app.inject({ method: "POST", url: "/logs/level", payload: { level: "debug" } });
    probe.debug({}, "after");

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/logs");
    const streamed = sseRecords((await app.inject({ method: "GET", url: "/logs/stream?once=1" })).body);
    expect(streamed.filter((r) => r.component === "probe").map((r) => r.msg)).toEqual(["after"]);
    expect(stdout.filter((r) => r.component === "probe").map((r) => r.msg)).toEqual(["after"]);
  });

  it("drops records below a raised level", async () => {
    const { app } = await start({ logLevel: "info" });

    await app.inject({ method: "POST", url: "/logs/level", payload: { level: "warn" } });
    await app.inject({ method: "GET", url: "/health" });

    const streamed = sseRecords((await app.inject({ method: "GET", url: "/logs/stream?once=1" })).body);
    expect(streamed.some((r) => r.url === "/health")).toBe(false);
  });

  it("rejects an unknown level and keeps the current one", async () => {
    const { app } = await start({ logLevel: "info" });

    const res = await app.inject({ method: "POST", url: "/logs/level", payload: { level: "silent" } });

    expect(res.statusCode).toBe(400);
    expect(app.ctx.logs.getLevel()).toBe("info");
  });
});

describe("GET /logs", () => {
  it("renders the live log view with the current level selected", async () => {
    const { app } = await start({ logLevel: "info" });
    await app.inject({ method: "POST", url: "/logs/level", payload: { level: "debug" } });

    const res = await app.inject({ method: "GET", url: "/logs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<h1>Logs</h1>");
    expect(res.body).toContain("Current level: debug");
    expect(res.body).toMatch(/<form method="post" action="\/logs\/level">/);
    expect(res.body).toContain('<option value="debug" selected>');
    expect(res.body).toContain('new EventSource("/logs/stream")');
  });

  it("is in Swedish by default", async () => {
    const { app } = await start();

    const res = await app.inject({ method: "GET", url: "/logs", headers: { cookie: "" } });

    expect(res.body).toContain("<h1>Loggar</h1>");
  });

  it("is linked from Settings", async () => {
    const { app } = await start();

    const res = await app.inject({ method: "GET", url: "/settings" });

    expect(res.body).toContain('<a href="/logs">Logs</a>');
  });
});
