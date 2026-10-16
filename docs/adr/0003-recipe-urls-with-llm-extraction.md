# Ingredient sources: manual, recipe URL, or LLM-found — with adaptations

---
Status: proposed (adopted by assumption 2026-10-16, amended and confirmed by owner 2026-10-16)
---

A Dish's Ingredients come from one of three sources, by precedence: (1) manually entered ingredients — for kid-adapted dishes the household doesn't follow a recipe for; (2) a recipe URL the Dish points to (ICA, Arla, …), fetched and extracted by the LLM at plan time, because recipe page formats vary wildly and no public recipe API covers the sites a Swedish household actually cooks from; (3) neither — the LLM finds a recipe from the dish name alone and extracts from that. In all cases, free-text Adaptations ("no chili — the kids") are applied during extraction, so the Shopping List reflects what the household actually cooks.

Rejected alternatives: integrating a recipe API (poor coverage of the relevant sites, plus an API-key burden on self-hosters), requiring manual ingredients for every dish (too much friction to add a favorite), and *requiring* a URL (rules out both own recipes and LLM-found ones). Consequences: ingredient extraction is best-effort; URL-extracted results are cached per URL + content hash so a plan doesn't re-scrape; LLM-found recipes are less predictable, so the Planned Dinner links its source for a human glance.
