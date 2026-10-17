import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ONLINE_ONLY_ROUTES, OFFLINE_PAGES, PREWARM_PAGES, QUEUEABLE_ROUTES } from "./allowlist.js";

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

describe("the service worker script", () => {
  async function workerScript() {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/sw.js" });
    const match = /^self\.OFFLINE_CONFIG = (\{[\s\S]*?\});\n/.exec(res.body);
    return { app, res, match, config: JSON.parse(match?.[1] ?? "null") };
  }

  it("is uncached JavaScript: the config line, then the worker file verbatim", async () => {
    const { res, match } = await workerScript();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(match).not.toBeNull();
    const worker = readFileSync(new URL("../../public/offline/worker.js", import.meta.url), "utf8");
    expect(res.body.slice(match![0].length)).toBe(worker);
  });

  it("embeds the allowlist's queueable routes, online-only routes, offline pages and pre-warm pages", async () => {
    const { config } = await workerScript();

    expect(config.queueable).toEqual(QUEUEABLE_ROUTES);
    expect(config.onlineOnly).toEqual(ONLINE_ONLY_ROUTES);
    expect(config.pages).toEqual(OFFLINE_PAGES);
    expect(config.prewarm).toEqual(PREWARM_PAGES);
    expect(config.prewarm).toContain("/shopping?week={nextWeek}");
  });

  it("lists every served asset and the manifest, all of which the app serves", async () => {
    const { app, config } = await workerScript();

    expect(config.assets).toEqual(expect.arrayContaining(["/assets/app.css", "/assets/htmx-2.0.4.min.js", "/assets/icon-192.png", "/manifest.webmanifest"]));
    for (const url of config.assets) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
  });

  it("labels each queueable route and carries the offline texts in both languages", async () => {
    const { config } = await workerScript();

    expect(Object.keys(config.labels.sv)).toEqual(QUEUEABLE_ROUTES);
    expect(config.labels.sv["/dishes"]).toBe("Ny rätt");
    expect(config.labels.en["/dishes"]).toBe("New dish");
    expect(config.texts.sv).toMatchObject({ banner: "Visas från kopia, uppdaterad {time}", requiresConnection: "Kräver uppkoppling", back: "Tillbaka", unknownChange: "Ändring" });
    expect(config.texts.en).toMatchObject({ banner: "Shown from copy, updated {time}", saved: "Saved, will sync when the app next reaches home" });
  });

  it("carries the synthetic pages as full shell pages with back-link and text placeholders", async () => {
    const { config } = await workerScript();

    for (const lang of ["sv", "en"]) {
      for (const frame of ["requiresConnection", "saved"]) {
        const html: string = config.frames[lang][frame];
        expect(html, `${lang} ${frame}`).toMatch(/^<!doctype html>/);
        expect(html).toContain('<nav class="tabbar"');
        expect(html).toContain("{{text}}");
        expect(html).toContain('href="{{back}}"');
      }
    }
    expect(config.frames.sv.saved).toContain(">Tillbaka</a>");
    expect(config.frames.en.requiresConnection).toContain(">Back</a>");
  });
});
