import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function makeApp() {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-offline-")), now: () => new Date(2026, 9, 21, 18, 30), logLevel: "info", logDestination: { write: () => true } });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("the web app manifest", () => {
  it("serves an installable, standalone manifest with the Swedish names and paper colours", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/manifest.webmanifest" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/manifest+json");
    const manifest = JSON.parse(res.body);
    expect(manifest).toMatchObject({
      name: "Måltidsplaneraren",
      short_name: "Måltider",
      lang: "sv",
      start_url: "/",
      display: "standalone",
      theme_color: "#fbfaf6",
      background_color: "#fbfaf6",
    });
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
  });

  it("serves every icon it names, and the apple-touch-icon, as PNG of the stated size", async () => {
    const app = await makeApp();
    const manifest = JSON.parse((await app.inject({ method: "GET", url: "/manifest.webmanifest" })).body);
    const icons: [string, number][] = [...manifest.icons.map((icon: { src: string; sizes: string }) => [icon.src, Number(icon.sizes.split("x")[0])]), ["/assets/apple-touch-icon.png", 180]];
    for (const [src, size] of icons) {
      const res = await app.inject({ method: "GET", url: src });
      expect(res.statusCode, src).toBe(200);
      expect(res.headers["content-type"], src).toBe("image/png");
      const png = res.rawPayload;
      expect(png.subarray(1, 4).toString("latin1"), src).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], src).toEqual([size, size]);
    }
  });
});
