// The offline service worker (ADR-0007), served at /sw.js as a module worker after a
// `self.OFFLINE_CONFIG = {...};` line built by src/offline/routes.ts. Thin glue: every decision
// lives in the pure core (public/offline/core.js, tested in src/offline/core.test.ts); this file
// only touches caches, the network and clients.
// Read side (Offline Copy) is here; #107 adds the write side (Pending Changes).

import { cacheKeysFor, classify, extractLang, offlineResponseFor, prewarmUrls } from "/assets/offline-core.js";

const config = self.OFFLINE_CONFIG;
const ASSETS_CACHE = "assets-v1";
const PAGES_CACHE = "pages-v1";
const META_CACHE = "meta-v1";
/** The language of the last page stored, so synthetic pages speak it. */
const LANG_KEY = "/__offline/lang";
const FETCHED_AT = "x-fetched-at";

/** "YYYY-MM-DD" on the device clock. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function tellClients(online) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage({ type: "connectivity", online });
}

async function lastLang() {
  const stored = await (await caches.open(META_CACHE)).match(LANG_KEY);
  return stored ? stored.text() : "sv";
}

/** Keeps a successful HTML response as the Offline Copy of `url`, stamped with when it was fetched. */
async function storePage(url, response) {
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.set(FETCHED_AT, new Date().toISOString());
  await (await caches.open(PAGES_CACHE)).put(url, new Response(html, { status: 200, headers }));
  await (await caches.open(META_CACHE)).put(LANG_KEY, new Response(extractLang(html)));
}

async function findCopy(url) {
  const pages = await caches.open(PAGES_CACHE);
  for (const key of cacheKeysFor(url, today())) {
    const cached = await pages.match(key);
    if (cached) return { html: await cached.text(), fetchedAt: cached.headers.get(FETCHED_AT) ?? new Date(0).toISOString() };
  }
  return undefined;
}

/** Refetches the pre-warm list so the Offline Copy is fresh even for pages not opened today. */
async function prewarm() {
  await Promise.all(
    prewarmUrls(config.prewarm, today()).map(async (path) => {
      const url = new URL(path, self.location.origin).href;
      try {
        const response = await fetch(url);
        if (response.ok && !response.redirected) await storePage(url, response);
      } catch {
        // Offline again; the previous copy stays.
      }
    }),
  );
}

async function handleAsset(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) await (await caches.open(ASSETS_CACHE)).put(request, response.clone());
    return response;
  } catch {
    return offlineResponseFor({ kind: "asset" }, { config, lang: "sv" });
  }
}

async function handlePage(event, classification) {
  const { request } = event;
  try {
    const response = await fetch(request);
    void tellClients(true);
    if (classification.cacheable && response.ok && !response.redirected) await storePage(request.url, response.clone());
    if (request.mode === "navigate" && response.ok) event.waitUntil(prewarm());
    return response;
  } catch {
    void tellClients(false);
    const copy = classification.cacheable ? await findCopy(request.url) : undefined;
    const lang = copy ? extractLang(copy.html) : await lastLang();
    return offlineResponseFor(classification, { config, lang, copy });
  }
}

async function handleWrite(request) {
  try {
    const response = await fetch(request);
    void tellClients(true);
    return response;
  } catch (error) {
    void tellClients(false);
    throw error; // #107 queues queueable writes and answers online-only ones offline.
  }
}

async function handlePassthrough(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponseFor({ kind: "passthrough" }, { config, lang: "sv" });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await (await caches.open(ASSETS_CACHE)).addAll(config.assets);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (new URL(request.url).origin !== self.location.origin) return;
  const classification = classify(request, config);
  switch (classification.kind) {
    case "asset":
      return event.respondWith(handleAsset(request));
    case "page":
      return event.respondWith(handlePage(event, classification));
    case "queueable-write":
    case "online-only-write":
      return event.respondWith(handleWrite(request));
    default:
      return event.respondWith(handlePassthrough(request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "prewarm") event.waitUntil(prewarm());
});
