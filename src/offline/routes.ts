/**
 * The installable shell (ADR-0007): the web app manifest and the service worker script. The
 * worker gets everything it must not hardcode (the allowlist, assets, texts, synthetic pages)
 * from `workerConfig()`, embedded as `self.OFFLINE_CONFIG` ahead of public/offline/worker.js.
 */
import { readFileSync } from "node:fs";
import type { FeaturePlugin } from "../app.js";
import { LANGS, t, type Lang, type MessageKey } from "../i18n/index.js";
import { ALL_ASSET_PATHS, ASSET_PATHS } from "../ui/assets.js";
import { escapeHtml, MANIFEST_PATH, page, THEME_COLOR } from "../ui/layout.js";
import { OFFLINE_PAGES, ONLINE_ONLY_ROUTES, PREWARM_PAGES, QUEUEABLE_LABELS, QUEUEABLE_ROUTES } from "./allowlist.js";

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

/** Texts the worker shows itself, per language. Sibling tickets add their keys here. */
const TEXT_KEYS = {
  banner: "offline.banner",
  requiresConnection: "offline.requiresConnection",
  saved: "offline.saved",
  back: "offline.back",
  unknownChange: "offline.unknownChange",
} as const satisfies Record<string, MessageKey>;

type Texts = Record<keyof typeof TEXT_KEYS, string>;

export interface WorkerConfig {
  queueable: readonly string[];
  onlineOnly: readonly string[];
  pages: readonly string[];
  prewarm: readonly string[];
  assets: readonly string[];
  labels: Record<Lang, Record<string, string>>;
  texts: Record<Lang, Texts>;
  frames: Record<Lang, { requiresConnection: string; saved: string }>;
}

function perLang<T>(build: (lang: Lang) => T): Record<Lang, T> {
  return Object.fromEntries(LANGS.map((lang) => [lang, build(lang)])) as Record<Lang, T>;
}

/** A synthetic page in the normal shell; the worker fills in `{{text}}` and `{{back}}`. */
function frame(lang: Lang, titleKey: MessageKey): string {
  const body = `<p>{{text}}</p>
<p><a href="{{back}}">${escapeHtml(t(lang, "offline.back"))}</a></p>`;
  return page({ title: t(lang, titleKey), body, tab: "today", lang });
}

/** The JSON the worker runs on. Language-independent: every language's texts are included. */
export function workerConfig(): WorkerConfig {
  return {
    queueable: QUEUEABLE_ROUTES,
    onlineOnly: ONLINE_ONLY_ROUTES,
    pages: OFFLINE_PAGES,
    prewarm: PREWARM_PAGES,
    assets: [...ALL_ASSET_PATHS, MANIFEST_PATH],
    labels: perLang((lang) => Object.fromEntries(Object.entries(QUEUEABLE_LABELS).map(([route, key]) => [route, t(lang, key)]))),
    texts: perLang((lang) => Object.fromEntries(Object.entries(TEXT_KEYS).map(([name, key]) => [name, t(lang, key)])) as Texts),
    frames: perLang((lang) => ({ requiresConnection: frame(lang, "offline.requiresConnection"), saved: frame(lang, "offline.saved") })),
  };
}

const WORKER_FILE = new URL("../../public/offline/worker.js", import.meta.url);

export const offlineRoutes: FeaturePlugin = async (app) => {
  const worker = `self.OFFLINE_CONFIG = ${JSON.stringify(workerConfig())};\n${readFileSync(WORKER_FILE, "utf8")}`;

  app.get(MANIFEST_PATH, async (_req, reply) => reply.type("application/manifest+json; charset=utf-8").send(JSON.stringify(MANIFEST)));

  app.get("/sw.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(worker));
};
