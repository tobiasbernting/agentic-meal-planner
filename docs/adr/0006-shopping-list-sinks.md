# Shopping list sinks: Trello (primary), generic webhook (optional)

---
Status: Accepted (amended 2026-10-16: Trello replaces Bring!/Home Assistant as the primary sink, after the owner ruled out both)
---

The "Buy" section of each Shopping List is pushed outward so the list is on the phone in the store. Sinks sit behind a `ShoppingListSink` interface (`push(items) → void`), all optional and composable:

1. **Trello (primary, v1).** Each week's Buy list becomes a new list on the shared shopping board, named by its Monday date. The push is one-way: the app creates cards and never reads the board back, so ticking items off stays in Trello. Trello's REST API is free and self-serve (API key and token), works for personal accounts, and its free workspace covers the owner and their partner. The household uses the same board for house planning, which is outside this app's scope (see SPEC non-goals).
2. **Generic webhook (optional, v1).** Zero-auth POST to a configurable URL, with ntfy as the reference default. The project owns both ends of the contract, so breakage risk is minimal, and contributors can wire up any other service without maintained per-service code.

Rejected as v1 built-ins:
- **Bring!**: not used by the household.
- **Home Assistant**: not reachable from outside the home network, and the household has no need for its fan-out.
- **MS To Do and Todoist**: MS To Do's API support for personal accounts could not be confirmed, and Todoist's board view is more basic than Trello's.
- **Self-hosted boards (Vikunja, Wekan, Planka)**: need a server that the partner's phone can reach, which the design does not provide.
- **AnyList, OurGroceries, Listonic, Google Keep, Matlistan**: no usable public API, or US-centric. Welcome as contributions.

Push failures degrade gracefully: the list stays in the app and the UI surfaces the error.
