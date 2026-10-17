# Offline-first via service worker with queued writes

---
Status: Accepted (owner, 2026-10-17)
---

The server runs on the home LAN only (ADR-0002) and is unreachable from the store, the school, or anywhere else the household actually consults the plan. We keep it that way and make the web UI offline-first instead: a service worker serves an Offline Copy of Today, Plan, Shopping, Dishes and Pantry, pre-warmed on every online visit, and queues a fixed allowlist of writes as Pending Changes that replay on the next visit (Background Sync where the browser offers it; iOS does not). The app is installable so iOS keeps its caches.

Writes stay plain `<form method="post">` and the service worker intercepts failed POSTs, so no feature needs its own offline code. Every queueable route carries an `Idempotency-Key` the server dedupes, because replays can fire twice. Only edits that need no Plan Run queue: dishes, pantry, settings, quick days, and the Shopping List's own edits (Checked Off, Extra Item, Removed Line). Generate, regenerate, confirm, swap, shopping build and push, lunch refresh and school retry need the server and an LLM and are disabled offline. Conflicts resolve last-write-wins; a rejected replay is shown and dropped, no merge UI.

Considered and rejected:
- **Tailscale or an exposed port**: solves reach for the owner, but open-source users should not need a VPN to use a phone app in a store, and it does nothing for no-signal spots.
- **SPA plus JSON API**: proper offline-first shape, but doubles every template and throws away the server-rendered, htmx-based UI for a single-household app.
- **Keep ticking in Trello only**: the list already lives there, but the household wants add, remove and tick in one place, and Trello cannot restore Dish-derived lines.

Consequences: every new write route must be a plain POST, idempotent under the key, and sorted into the allowlist or the online-only set. Pending Changes are not rendered optimistically into the Offline Copy; the banner lists them instead.
