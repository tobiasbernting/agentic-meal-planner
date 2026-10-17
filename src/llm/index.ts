import { CliAgent, type CliAgentDeps } from "./cli-agent.js";
import { NoAgent } from "./no-agent.js";
import type { LlmAgent } from "./types.js";

export type {
  LlmAgent,
  LlmResult,
  Ingredient,
  ExtractIngredientsOptions,
  LunchEntry,
  Dish,
  SelectDishesInput,
  ExistingDish,
  SelectedDish,
  DishSuggestion,
  SeedDish,
  FoundRecipe,
  MatchPantryInput,
  PantryMatch,
} from "./types.js";
export { AgentTimeoutError, CliAgent, type CliAgentDeps, type ProcessResult, type ProcessRunner } from "./cli-agent.js";
export { SEED_DISHES, DEFAULT_SUGGESTION_STYLE } from "./seed-dishes.js";
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

/**
 * An agent resolver that follows the configured command: each call re-reads it through
 * `readCommand` and rebuilds the agent only when the command changed, so a new
 * `agent_command` saved in Settings is used by the next run without a restart.
 * `deps.log` receives every CliAgent call's records.
 */
export function configuredLlmAgent(readCommand: () => string | undefined, deps?: CliAgentDeps): () => LlmAgent {
  let command: string | undefined;
  let agent: LlmAgent | undefined;
  return () => {
    const next = readCommand()?.trim() || undefined;
    if (!agent || next !== command) {
      command = next;
      agent = createLlmAgent(next, deps);
    }
    return agent;
  };
}
