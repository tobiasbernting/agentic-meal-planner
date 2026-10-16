# Recipe URLs as source of truth, LLM ingredient extraction

---
Status: proposed (adopted by assumption in an unattended design session, awaiting owner confirmation)
---

A Favorite Dish's recipe lives at an external URL (ICA, Arla, whatever the household actually uses). At plan time, the Planner Agent fetches the URL and extracts the ingredient list via LLM, because recipe page formats vary wildly and no public recipe API covers the sites a Swedish household actually cooks from. Dishes without a URL (own recipes) carry manually entered ingredients instead.

Rejected alternatives: integrating a recipe API (poor coverage of the relevant sites, plus an API-key burden on self-hosters), and requiring manual ingredients for every dish (too much friction to add a favorite — paste-a-URL is the whole UX). Consequences: ingredient extraction is best-effort and its output is cached per recipe URL, so a plan doesn't re-scrape; the Shopping List may occasionally need a human glance, which the UI acknowledges by showing source links.
