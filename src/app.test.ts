import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-app-"));
  const app = await buildApp({ dataDir });
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

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
