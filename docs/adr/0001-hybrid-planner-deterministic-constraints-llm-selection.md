# Hybrid planner: deterministic constraints, LLM selection

---
Status: Accepted (confirmed by owner 2026-10-16)
---

The Weekly Plan is produced in two stages. Stage one is plain deterministic code: fetch Lunch Menus, filter Favorite Dishes by hard constraints (no collision with that day's school lunch — on exact dish name and on Main Category, Quick Day prep-time limits). Stage two hands the eligible candidates per day to an LLM agent, which makes the actual picks and does the fuzzy matching code can't (is "tortilla wraps med tacokrydda" the same as our "Taco Tuesday"?).

Variety is deliberately **not** a hard constraint: households have weekly staples (burgers every Friday). Recently-planned dishes are passed to the selection step as a soft preference over a configurable window (default 3 weeks) — the agent may repeat a dish and must say why in its rationale.

The alternative — letting the LLM produce the whole plan in one shot — was rejected because hard constraints must be guaranteed and testable, not prompt-engineered. The alternative of skipping the LLM entirely was rejected because lunch menus and recipe pages are messy free text; fuzzy matching is exactly what an LLM is good at. All LLM work sits behind a narrow interface, so the deterministic core runs (degraded) even with no LLM configured.
