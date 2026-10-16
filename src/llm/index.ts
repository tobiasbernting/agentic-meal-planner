import { CliAgent, type CliAgentDeps } from "./cli-agent.js";
import { NoAgent } from "./no-agent.js";
import type { LlmAgent } from "./types.js";

export type { LlmAgent, LlmResult, Ingredient, LunchEntry, Dish, SelectDishesInput, SelectedDish, FoundRecipe } from "./types.js";
export { CliAgent, type CliAgentDeps, type ProcessRunner } from "./cli-agent.js";
export { NoAgent, NO_AGENT_REASON } from "./no-agent.js";
export { ScriptedLlmAgent, type ScriptedResponses } from "./fake.js";

/**
 * Builds the LlmAgent for a deployment: the CLI subprocess agent when `agent_command`
 * is set (settings table or AGENT_COMMAND env), otherwise the FR-16 no-agent fallback.
 */
export function createLlmAgent(agentCommand: string | undefined, deps?: CliAgentDeps): LlmAgent {
  const command = agentCommand?.trim();
  if (!command) return new NoAgent();
  return new CliAgent(command, deps);
}
