// The offline service worker (ADR-0007), served at /sw.js as a module worker after a
// `self.OFFLINE_CONFIG = {...};` line built by src/offline/routes.ts. Thin glue: every decision
// lives in the pure core (public/offline/core.js, tested in src/offline/core.test.ts); this file
// only touches caches, IndexedDB, the network and clients.
// Read side: the Offline Copy. Write side: Pending Changes, stored in IndexedDB and replayed.

import {
  backPath,
  cacheKeysFor,
  classify,
  extractLang,
  firstAttemptRequest,
  newPendingChange,
  offlineResponseFor,
  prewarmUrls,
  replayOrder,
  replayOutcome,
  replayRequest,
  routeLabel,
} from "/assets/offline-core.js";

const config = self.OFFLINE_CONFIG;
// Assets and Offline Copies are named by config.version, which changes with every deploy that
// changes an asset or this file; activate drops every other version's caches.
const ASSETS_CACHE = `assets-${config.version}`;
const PAGES_CACHE = `pages-${config.version}`;
/** Kept across versions: only the language of the last page stored. */
const META_CACHE = "meta";
/** The language of the last page stored, so synthetic pages speak it. */
const LANG_KEY = "/__offline/lang";
const FETCHED_AT = "x-fetched-at";
const SYNC_TAG = "pending-changes";

/** "YYYY-MM-DD" on the device clock. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * How long a network attempt may take before the Offline Copy or the Pending Change takes over.
 * A phone with wifi off and cellular on black-holes a LAN address for over a minute instead of
 * failing, so a plain fetch would leave the household staring at a blank page. Writes get longer,
 * since a Dish save may wait on the LLM; a write that timed out but did reach the server is
 * deduped on replay by its Idempotency-Key.
 */
const TIMEOUT_MS = { page: 3000, write: 6000, passthrough: 3000, background: 15000 };

/** `fetch` that rejects after `ms`, like a network error, so every caller's offline path runs. */
function fetchWithin(ms, input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function tellClients(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage(message);
}

/**
 * Every page load and write first asks the server for /health with a short deadline. On the home
 * LAN that answers in a few milliseconds, so the real request follows at once; away from home the
 * deadline passes and the Offline Copy or the Pending Change answers instead, with no state to
 * remember and nothing to expire. The deadline leaves room for a phone's wifi radio waking from
 * power-save, which alone takes 100 to 200 ms.
 */
const PROBE_MS = 250;
/** One probe serves every request made within this window (a page and the assets it pulls). */
const PROBE_MEMO_MS = 1000;
let lastProbe = { at: 0, online: false };

async function serverReachable() {
  if (Date.now() - lastProbe.at < PROBE_MEMO_MS) return lastProbe.online;
  let online = false;
  try {
    online = (await fetchWithin(PROBE_MS, new URL("/health", self.location.origin).href, { cache: "no-store" })).ok;
  } catch {
    online = false;
  }
  lastProbe = { at: Date.now(), online };
  return online;
}

function noteOnline() {
  lastProbe = { at: Date.now(), online: true };
  void tellClients({ type: "connectivity", online: true });
}

function noteOffline() {
  lastProbe = { at: Date.now(), online: false };
  void tellClients({ type: "connectivity", online: false });
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
        response = await fetchWithin(TIMEOUT_MS.background, url, init);
        noteOnline();
      } catch {
        noteOffline();
      }
      const outcome = replayOutcome(response?.status, response ? await response.text() : "");
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
        const response = await fetchWithin(TIMEOUT_MS.background, url);
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
    const response = await fetchWithin(TIMEOUT_MS.page, request);
    if (response.ok) await (await caches.open(ASSETS_CACHE)).put(request, response.clone());
    return response;
  } catch {
    return offlineResponseFor({ kind: "asset" }, { config, lang: "sv" });
  }
}

/** The Offline Copy with its banner, or the requires-connection page. */
async function offlinePage(request, classification) {
  const copy = classification.cacheable ? await findCopy(request.url) : undefined;
  const lang = copy ? extractLang(copy.html) : await lastLang();
  return offlineResponseFor(classification, { config, lang, copy });
}

async function handlePage(event, classification) {
  const { request } = event;
  if (!(await serverReachable())) {
    noteOffline();
    return offlinePage(request, classification);
  }
  try {
    const response = await fetchWithin(TIMEOUT_MS.page, request);
    noteOnline();
    if (classification.cacheable && response.ok && !response.redirected) await storePage(request.url, response.clone());
    if (request.mode === "navigate" && response.ok) event.waitUntil(replayThenPrewarm());
    return response;
  } catch {
    noteOffline();
    return offlinePage(request, classification);
  }
}

/** The saved and requires-connection pages, which an offline htmx write redirects to. */
async function handleOfflinePage(request, classification) {
  const back = backPath(new URL(request.url).searchParams.get("back"), self.location.origin);
  return offlineResponseFor(classification, { config, lang: await lastLang(), back });
}

/**
 * A queueable write is built into its Pending Change first, so even the first attempt carries the
 * Idempotency-Key; if that attempt cannot reach the server the same entry is stored and the saved
 * page answers. An online-only write that cannot reach the server gets the requires-connection page.
 */
async function handleWrite(event, request, classification) {
  let entry;
  if (classification.kind === "queueable-write") {
    const body = await request.text();
    const contentType = request.headers.get("content-type") ?? "application/x-www-form-urlencoded";
    entry = newPendingChange({ url: request.url, body, contentType, now: new Date(), uuid: () => crypto.randomUUID() });
  }
  const offline = async () => {
    if (entry) await enqueue(entry);
    const back = backPath(request.referrer, self.location.origin);
    return offlineResponseFor(classification, { config, lang: await lastLang(), back, htmx: request.headers.has("HX-Request") });
  };
  if (!(await serverReachable())) {
    noteOffline();
    return offline();
  }
  try {
    const attempt = entry ? firstAttemptRequest(entry, request) : undefined;
    const response = await (attempt ? fetchWithin(TIMEOUT_MS.write, attempt.url, attempt.init) : fetchWithin(TIMEOUT_MS.write, request));
    noteOnline();
    return response;
  } catch {
    noteOffline();
    return offline();
  }
}

/**
 * Always tries the network: the page's /health ping is how the app notices it is back, and a
 * success there means the next tap goes to the server. Offline, htmx polling gets a quiet 204;
 * anything else a 503 that is not ok.
 */
async function handlePassthrough(request) {
  try {
    const response = await fetchWithin(TIMEOUT_MS.passthrough, request);
    if (response.ok && !lastProbe.online) noteOnline();
    return response;
  } catch {
    noteOffline();
    return offlineResponseFor({ kind: "passthrough" }, { config, lang: "sv", htmx: request.headers.has("HX-Request") });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Past the browser's HTTP cache (assets are served with max-age), so a new version caches new files.
      await (await caches.open(ASSETS_CACHE)).addAll(config.assets.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [ASSETS_CACHE, PAGES_CACHE, META_CACHE];
      for (const name of await caches.keys()) if (!keep.includes(name)) await caches.delete(name);
      await self.clients.claim();
      // The new version starts without Offline Copies, so fill them now while the server is near.
      await replayThenPrewarm();
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
      return event.respondWith(handleWrite(event, request, classification));
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
 * Messages from pages: `replay` (the app is back online), `prewarm`, `queue` (`{ lang }`, answered on the
 * message port with `{ type: "queue", entries }`, oldest first, each with a `label` in `lang`) and `discard` (`{ id }`).
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
          const lang = message.lang in config.texts ? message.lang : "sv";
          const entries = replayOrder(await pending.all()).map((entry) => ({
            ...entry,
            label: routeLabel(entry.method, new URL(entry.url, self.location.origin).pathname, config, lang),
          }));
          event.ports[0]?.postMessage({ type: "queue", entries });
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
