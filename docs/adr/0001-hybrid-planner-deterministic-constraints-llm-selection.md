# Hybrid planner: deterministic constraints, LLM selection

---
Status: Accepted (confirmed by owner 2026-10-16)
---

The Weekly Plan is produced in two stages. Stage one is plain deterministic code: fetch Lunch Menus, filter Favorite Dishes by hard constraints (no collision with that day's school lunch — on exact dish name and on Main Category, Quick Day prep-time limits). Stage two hands the eligible candidates per day to an LLM agent, which makes the actual picks and does the fuzzy matching code can't (is "tortilla wraps med tacokrydda" the same as our "Taco Tuesday"?).

Variety is deliberately **not** a hard constraint: households have weekly staples (burgers every Friday). Recently-planned dishes are passed to the selection step as a soft preference over a configurable window (default 3 weeks) — the agent may repeat a dish and must say why in its rationale.

The alternative — letting the LLM produce the whole plan in one shot — was rejected because hard constraints must be guaranteed and testable, not prompt-engineered. The alternative of skipping the LLM entirely was rejected because lunch menus and recipe pages are messy free text; fuzzy matching is exactly what an LLM is good at. All LLM work sits behind a narrow interface, so the deterministic core runs (degraded) even with no LLM configured.

## Suggested Dishes (2026-10-17)

Stage two may now propose a dish the household has not entered. When a dinner date has no eligible Favorite Dish after stage one (an empty rotation, or everything collides with that day's lunch), the agent fills that date with a Suggested Dish from family-friendly home cooking in a configurable style (default: Swedish, for a family with kids), in the same weekly selection call. Stage one still owns the hard rules: the suggestion's name and Main Category are re-checked against the day's Lunch Entries and Quick Day limit in code, and an offender is dropped. A Suggested Dish is stored as a real Dish outside the rotation, so Ingredients, the Shopping List and the Variety Preference treat it like any other; the household can promote it to a Favorite. With no agent, a built-in seed list of classics feeds the deterministic fallback under the same filter.

The alternative, leaving such dates empty ("no eligible dish, pick one"), was the original rule and made a fresh install produce an empty week. The alternative of letting the agent suggest freely on every date was rejected: the rotation is the household's choice, and suggestions only fill gaps.
