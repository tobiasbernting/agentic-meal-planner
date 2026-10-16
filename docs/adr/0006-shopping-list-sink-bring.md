# Shopping list pushed to Bring! behind a sink interface

---
Status: proposed (push-integration direction confirmed by owner 2026-10-16; Bring! as first sink is the assistant's suggestion, pending confirmation)
---

The "Buy" section of each Shopping List is pushed to the household's shopping-list app, so the list is on the phone in the store — not behind the planner's UI. v1 targets **Bring!**, the de facto standard in Swedish households, via its (unofficial) API; credentials come from environment variables, never the database.

Rejected alternatives: AnyList (US-centric, equally unofficial API), Todoist/Google Keep (todo apps — they hold text, but shopping UX with categories and shared household lists is the point), and email (passive; the list must live where you shop). Consequences: Bring!'s API is unofficial and can break — hence the `ShoppingListSink` interface (`push(items) → void`), with push failures degrading gracefully to the in-app list and surfacing the error in the UI. Other sinks (AnyList, OurGroceries, a webhook) are welcome contributions behind the same interface.
