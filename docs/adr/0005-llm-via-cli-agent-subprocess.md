# LLM executed as a configurable CLI agent subprocess

---
Status: Accepted (CLI configurability confirmed by owner 2026-10-16; subprocess execution adopted by assumption)
---

The Planner Agent invokes the LLM by shelling out to an agentic CLI — never a direct model API. **Which** CLI is a deployment setting (`agent_command`, default `copilot -p`); Copilot CLI, Claude Code, Codex, opencode, or anything that takes a prompt on the command line and prints a result will do. Prompts request structured JSON output; the response is validated and retried once before degrading.

Rejected alternatives: direct API integration (adds key management, billing setup, and per-provider plumbing to a project whose users may have neither), hard-coding one vendor's CLI (owners have different subscriptions — the person self-hosting this already pays for some agent CLI and shouldn't need another), and embedding an agent framework (heavyweight for three narrow prompts). The trade-off is real: output-format discipline depends on the CLI behaving, and authenticating the CLI inside the container is the owner's responsibility. That's why all LLM access sits behind the narrow `LlmAgent` interface (`extractLunchMenu`, `extractIngredients`, `findRecipe`, `selectDishes`) with a deterministic no-LLM fallback, so a misbehaving or missing agent degrades the plan instead of breaking it.

## Container (2026-10-17)

The official Docker image bundles no agent CLI, and that stays the default: the owner provides it by bind-mounting a binary plus its auth directory, or by building a derived image (see the README). Bundling would tie the image to one vendor, and these CLIs are not clearly redistributable or authenticable without interaction. Revisit if a redistributable agent CLI with non-interactive authentication becomes the default.
