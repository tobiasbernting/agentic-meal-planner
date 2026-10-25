import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ONLINE_ONLY_ROUTES, QUEUEABLE_ROUTES, isOnlineOnly, isQueueable } from "./allowlist.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("the write-route allowlist (ADR-0007)", () => {
  it("sorts every registered POST route into the queueable or the online-only set", async () => {
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-allowlist-")), logLevel: "info", logDestination: { write: () => true } });
    apps.push(app);
    await app.ready();

    expect(app.postRoutes).toContain("/dishes/:id");
    const unsorted = app.postRoutes.filter((route) => !isQueueable(route) && !isOnlineOnly(route));
    expect(unsorted, "add each new POST route to QUEUEABLE_ROUTES or ONLINE_ONLY_ROUTES").toEqual([]);
  });

  it("puts no route in both sets", () => {
    expect(QUEUEABLE_ROUTES.filter((route) => ONLINE_ONLY_ROUTES.includes(route))).toEqual([]);
  });

  it("matches Fastify route patterns exactly, not request paths", () => {
    expect(isQueueable("/dishes/:id")).toBe(true);
    expect(isQueueable("/dishes/7")).toBe(false);
    expect(isOnlineOnly("/plan/generate")).toBe(true);
    expect(isOnlineOnly("/shopping/push")).toBe(true);
    expect(isQueueable("/shopping/check")).toBe(true);
  });
});
