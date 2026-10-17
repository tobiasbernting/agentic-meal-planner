/**
 * The installable shell (ADR-0007): the web app manifest and the service worker script.
 */
import type { FeaturePlugin } from "../app.js";
import { ASSET_PATHS } from "../ui/assets.js";

/** Paper, the stylesheet's background token in light mode. */
export const THEME_COLOR = "#fbfaf6";

export const MANIFEST_PATH = "/manifest.webmanifest";

const MANIFEST = {
  name: "Måltidsplaneraren",
  short_name: "Måltider",
  lang: "sv",
  start_url: "/",
  display: "standalone",
  theme_color: THEME_COLOR,
  background_color: THEME_COLOR,
  icons: [
    { src: ASSET_PATHS.icon192, sizes: "192x192", type: "image/png" },
    { src: ASSET_PATHS.icon512, sizes: "512x512", type: "image/png" },
  ],
};

export const offlineRoutes: FeaturePlugin = async (app) => {
  app.get(MANIFEST_PATH, async (_req, reply) => reply.type("application/manifest+json; charset=utf-8").send(JSON.stringify(MANIFEST)));
};
