/**
 * Static assets served by the app (spec #71, NFR-2): the stylesheet, vendored HTMX and the
 * bundled Libre Franklin files. Nothing loads from another host. Files live in public/ at the
 * repo root (copied into the image next to dist/); they are read once at startup.
 */
import { readFileSync } from "node:fs";
import type { FeaturePlugin } from "../app.js";

/** public/ resolves the same from src/ui/ (tsx) and dist/ui/ (built). */
const PUBLIC_DIR = new URL("../../public/", import.meta.url);

const FILES: Record<string, { file: string; type: string }> = {
  "app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "htmx-2.0.4.min.js": { file: "vendor/htmx-2.0.4.min.js", type: "text/javascript; charset=utf-8" },
  "pending.js": { file: "pending.js", type: "text/javascript; charset=utf-8" },
  "libre-franklin-400.woff2": { file: "fonts/libre-franklin-400.woff2", type: "font/woff2" },
  "libre-franklin-600.woff2": { file: "fonts/libre-franklin-600.woff2", type: "font/woff2" },
  "libre-franklin-800.woff2": { file: "fonts/libre-franklin-800.woff2", type: "font/woff2" },
  "libre-franklin-900.woff2": { file: "fonts/libre-franklin-900.woff2", type: "font/woff2" },
  "icon-192.png": { file: "icons/icon-192.png", type: "image/png" },
  "icon-512.png": { file: "icons/icon-512.png", type: "image/png" },
  "apple-touch-icon.png": { file: "icons/apple-touch-icon.png", type: "image/png" },
};

/** URL paths pages reference. The stylesheet's @font-face rules use the font paths directly. */
export const ASSET_PATHS = {
  stylesheet: "/assets/app.css",
  htmx: "/assets/htmx-2.0.4.min.js",
  pending: "/assets/pending.js",
  fontRegular: "/assets/libre-franklin-400.woff2",
  icon192: "/assets/icon-192.png",
  icon512: "/assets/icon-512.png",
  appleTouchIcon: "/assets/apple-touch-icon.png",
} as const;

/** Every served asset's URL path, for the service worker to cache. */
export const ALL_ASSET_PATHS: readonly string[] = Object.keys(FILES).map((name) => `/assets/${name}`);

export const assetRoutes: FeaturePlugin = async (app) => {
  const loaded = new Map(Object.entries(FILES).map(([name, { file, type }]) => [name, { body: readFileSync(new URL(file, PUBLIC_DIR)), type }]));
  app.get<{ Params: { name: string } }>("/assets/:name", async (req, reply) => {
    const asset = loaded.get(req.params.name);
    if (!asset) return reply.code(404).send("Not found");
    // Names are stable per content (HTMX is versioned; the rest change rarely): an hour, then revalidate.
    return reply.type(asset.type).header("cache-control", "public, max-age=3600").send(asset.body);
  });
};
