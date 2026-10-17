// The offline service worker (ADR-0007), served at /sw.js as a module worker after a
// `self.OFFLINE_CONFIG = {...};` line built by src/offline/routes.ts. Thin glue: every decision
// lives in the pure core (public/offline/core.js, tested in src/offline/core.test.ts); this file
// only touches caches, IndexedDB, the network and clients.
// Read side: the Offline Copy. Write side: Pending Changes, queued in IndexedDB and replayed.

import {
  backPath,
  cacheKeysFor,
  classify,
  extractLang,
  newPendingChange,
  offlineResponseFor,
  prewarmUrls,
  replayOrder,
  replayOutcome,
  replayRequest,
} from "/assets/offline-core.js";

const config = self.OFFLINE_CONFIG;
const ASSETS_CACHE = "assets-v1";
const PAGES_CACHE = "pages-v1";
const META_CACHE = "meta-v1";
/** The language of the last page stored, so synthetic pages speak it. */
const LANG_KEY = "/__offline/lang";
const FETCHED_AT = "x-fetched-at";
const SYNC_TAG = "pending-changes";

/** "YYYY-MM-DD" on the device clock. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function tellClients(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage(message);
}

function tellConnectivity(online) {
  void tellClients({ type: "connectivity", online });
}

function tellPendingChanged() {
  void tellClients({ type: "pending-changed" });
}

async function lastLang() {
  const stored = await (await caches.open(META_CACHE)).match(LANG_KEY);
  return stored ? stored.text() : "sv";
}

// Pending Changes: one IndexedDB object store, keyed by the entry's id.

const DB_NAME = "offline";
const STORE = "pending";

function openDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "id" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** Runs one store operation in its own transaction and resolves with its result once committed. */
async function inStore(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const pending = {
  all: () => inStore("readonly", (store) => store.getAll()),
  put: (entry) => inStore("readwrite", (store) => store.put(entry)),
  delete: (id) => inStore("readwrite", (store) => store.delete(id)),
};

/** Stores a Pending Change and asks for Background Sync where the browser has it (iOS has none). */
async function enqueue(entry) {
  await pending.put(entry);
  tellPendingChanged();
  if ("sync" in self.registration) await self.registration.sync.register(SYNC_TAG).catch(() => {});
}

let replaying;

/**
 * Replays pending entries oldest first with their stored Idempotency-Key. Drops what the server
 * took, marks what it refused as failed (skipped from then on), and stops at the first network
 * error or server failure so later edits never overtake earlier ones. Resolves to whether the
 * run got through. One run at a time.
 */
function replay() {
  replaying ??= runReplay().finally(() => {
    replaying = undefined;
  });
  return replaying;
}

async function runReplay() {
  const queue = replayOrder((await pending.all()).filter((entry) => entry.state === "pending"));
  let changed = false;
  try {
    for (const entry of queue) {
      const { url, init } = replayRequest(entry);
      let response;
      try {
        response = await fetch(url, init);
      } catch {
        tellConnectivity(false);
        return false;
      }
      tellConnectivity(true);
      const outcome = replayOutcome(response.status, await response.text());
      if (outcome.kind === "keep") return false;
      if (outcome.kind === "drop") await pending.delete(entry.id);
      else await pending.put({ ...entry, state: "failed", reason: outcome.reason });
      changed = true;
    }
    return true;
  } finally {
    if (changed) tellPendingChanged();
  }
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

/** Replay first, so the refreshed Offline Copy already shows the household's edits. */
async function replayThenPrewarm() {
  await replay();
  await prewarm();
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
    tellConnectivity(true);
    if (classification.cacheable && response.ok && !response.redirected) await storePage(request.url, response.clone());
    if (request.mode === "navigate" && response.ok) event.waitUntil(replayThenPrewarm());
    return response;
  } catch {
    tellConnectivity(false);
    const copy = classification.cacheable ? await findCopy(request.url) : undefined;
    const lang = copy ? extractLang(copy.html) : await lastLang();
    return offlineResponseFor(classification, { config, lang, copy });
  }
}

/** The saved and requires-connection pages, which an offline htmx write redirects to. */
async function handleOfflinePage(request, classification) {
  const back = backPath(new URL(request.url).searchParams.get("back"), self.location.origin);
  return offlineResponseFor(classification, { config, lang: await lastLang(), back });
}

/**
 * A queueable write that cannot reach the server becomes a Pending Change and gets the saved
 * page; an online-only one gets the requires-connection page. The body is read before the fetch
 * consumes the request.
 */
async function handleWrite(request, classification) {
  const body = classification.kind === "queueable-write" ? await request.clone().text() : undefined;
  try {
    const response = await fetch(request);
    tellConnectivity(true);
    return response;
  } catch {
    tellConnectivity(false);
    if (body !== undefined) {
      const contentType = request.headers.get("content-type") ?? "application/x-www-form-urlencoded";
      await enqueue(newPendingChange({ url: request.url, body, contentType, now: new Date(), uuid: () => crypto.randomUUID() }));
    }
    const back = backPath(request.referrer, self.location.origin);
    return offlineResponseFor(classification, { config, lang: await lastLang(), back, htmx: request.headers.has("HX-Request") });
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
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await replay();
    })(),
  );
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
    case "offline-page":
      return event.respondWith(handleOfflinePage(request, classification));
    case "queueable-write":
    case "online-only-write":
      return event.respondWith(handleWrite(request, classification));
    default:
      return event.respondWith(handlePassthrough(request));
  }
});

/** Background Sync (not on iOS): a run that does not get through rejects, so the browser retries. */
self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    (async () => {
      if (!(await replay())) throw new Error("Pending Changes not replayed yet");
      await prewarm();
    })(),
  );
});

/**
 * Messages from pages: `replay` (the app is back online), `prewarm`, `queue` (answered on the
 * message port with `{ type: "queue", entries }`, oldest first) and `discard` (`{ id }`).
 */
self.addEventListener("message", (event) => {
  const message = event.data ?? {};
  switch (message.type) {
    case "replay":
    case "prewarm":
      return event.waitUntil(replayThenPrewarm());
    case "queue":
      return event.waitUntil(
        (async () => {
          event.ports[0]?.postMessage({ type: "queue", entries: replayOrder(await pending.all()) });
        })(),
      );
    case "discard":
      return event.waitUntil(
        (async () => {
          await pending.delete(message.id);
          tellPendingChanged();
        })(),
      );
  }
});
