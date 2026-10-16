# Shopping list sinks: webhook (ntfy default), Bring!, Home Assistant

---
Status: proposed (direction confirmed by owner 2026-10-16; sink selection amended 2026-10-16 after integration research)
---

The "Buy" section of each Shopping List is pushed outward so the list is on the phone in the store. Three sinks ship in v1 behind a `ShoppingListSink` interface (`push(items) → void`), all optional and composable:

1. **Generic webhook, with ntfy as the batteries-included default.** Zero-auth POST to a configurable URL; the project owns both ends of the contract, so breakage risk is minimal, and contributors can wire up any other service without maintained per-service code.
2. **Bring!** — the de facto shopping-list app in Sweden/DACH: shared household lists, categories, phone-native. Integration via the community TypeScript wrapper (email+password auth, credentials from env vars, never the database). Risk: unofficial API; mitigated by pinning/vendoring and by the other sinks.
3. **Home Assistant** `todo`/`shopping_list` — the owner runs HA, and the planner reaches it over the LAN (no inbound internet exposure needed). HA doubles as a fan-out hub: automations sync the list onward (e.g. to Bring!'s cloud, which only needs *outbound* access) and to every family member's Companion app. Official, stable REST API.

Rejected as v1 built-ins: Todoist (official API but not shopping-specific — a webhook example instead), AnyList/OurGroceries (US-centric; welcome as contributions), Listonic/Google Keep/Matlistan (no usable API), Mealie (overlapping product). Push failures degrade gracefully: the list stays in the app and the UI surfaces the error.
