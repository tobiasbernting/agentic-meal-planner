# LLM executed as a CLI agent subprocess (`copilot -p`)

---
Status: proposed (adopted by assumption in an unattended design session, awaiting owner confirmation)
---

The Planner Agent invokes the LLM by shelling out to an agentic CLI — GitHub Copilot CLI (`copilot -p`, with structured JSON output requested in the prompt) — rather than calling a model API directly. The Docker image bundles the CLI; the owner authenticates it once.

Rejected alternatives: direct API integration (adds key management, billing setup, and per-provider plumbing to a project whose users may have neither), and embedding an agent framework (heavyweight for three narrow prompts). The trade-off is real: coupling to the Copilot CLI's auth model and output format, and no streaming. That's why all LLM access sits behind the narrow `LlmAgent` interface (`extractLunchMenu`, `extractIngredients`, `selectDishes`) with a deterministic no-LLM fallback, so swapping the execution mechanism touches one file.
