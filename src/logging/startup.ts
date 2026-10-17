/**
 * Startup self-check (spec #42): what the server resolved at boot, so misconfiguration is
 * obvious in the first log lines. Pure apart from the PATH lookup's filesystem stat.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

type EnvLike = Record<string, string | undefined>;

/** The executable an agent command runs: its first whitespace-separated token. */
export function agentBinary(agentCommand: string | undefined): string | undefined {
  return agentCommand?.trim().split(/\s+/)[0] || undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether the agent command's binary exists: a path is checked directly, a bare name is searched in `env.PATH`. No agent call. */
export function agentBinaryFound(agentCommand: string | undefined, env: EnvLike): boolean {
  const binary = agentBinary(agentCommand);
  if (!binary) return false;
  if (binary.includes("/")) return isExecutableFile(binary);
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => isExecutableFile(join(dir, binary)));
}

export interface StartupInput {
  agentCommand: string | undefined;
  env: EnvLike;
  cronExpression: string;
  dataDir: string;
  /** Time zone saved in Settings, which overrides TZ for "today" and the weekly run. */
  timezone?: string;
}

export interface StartupReport {
  agentCommand: string | null;
  agentBinary: string | null;
  agentBinaryFound: boolean;
  /** The process time zone: `TZ`, else what the runtime resolved. */
  tz: string;
  timezone?: string;
  dataDir: string;
  cronExpression: string;
}

export function startupReport({ agentCommand, env, cronExpression, dataDir, timezone }: StartupInput): StartupReport {
  const command = agentCommand?.trim() || null;
  return {
    agentCommand: command,
    agentBinary: agentBinary(agentCommand) ?? null,
    agentBinaryFound: agentBinaryFound(agentCommand, env),
    tz: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(timezone ? { timezone } : {}),
    dataDir,
    cronExpression,
  };
}
