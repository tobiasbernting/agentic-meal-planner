import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
