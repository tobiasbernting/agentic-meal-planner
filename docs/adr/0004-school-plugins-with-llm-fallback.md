# School lunch ingestion: plugin interface with LLM fallback

---
Status: proposed (adopted by assumption in an unattended design session, awaiting owner confirmation)
---

Each School is configured as one or more menu URLs. Ingestion goes through a plugin interface — `scrape(url, week) → LunchEntry[]` — with plugins per known site/format living in the repo so contributors can add their kids' schools. When no plugin claims a URL, a generic fallback fetches the page (or PDF) and asks the LLM to extract the week's lunches as structured data.

Rejected alternatives: plugins only (the system would be useless until someone writes a scraper for your school — fatal for adoption), and LLM only (costly, flaky, and non-deterministic for high-traffic formats a plugin handles perfectly). The two layers are complementary: the fallback gets a new user running in minutes; plugins make popular schools reliable and cheap. A plugin is promoted from a working fallback case, not designed up front.
