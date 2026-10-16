import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { openDatabase, readSetting } from "./db.js";
import { configuredLlmAgent } from "./llm/index.js";
import type { LlmAgent } from "./llm/types.js";
import { SETTING_AGENT_COMMAND } from "./planner/settings.js";
import type { FetchPage } from "./plugins/schools/index.js";
import { todayRoutes } from "./today/routes.js";
import { planRoutes } from "./plan/routes.js";
import type { Env, FetchLike } from "./sinks/types.js";
import { shoppingRoutes } from "./shopping/routes.js";
import { dishRoutes } from "./dishes/routes.js";
import { schoolRoutes } from "./schools/routes.js";
import { pantryRoutes } from "./pantry/routes.js";
import { settingsRoutes } from "./settings/routes.js";
import { langRoutes } from "./i18n/routes.js";

export interface AppOptions {
  dataDir: string;
  /** Override the LLM port (tests pass a ScriptedLlmAgent). Defaults from `agent_command`. */
  llm?: LlmAgent;
  /** Clock; tests inject a fixed date. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Fetches a web page as text (menu/recipe pages). Defaults to global `fetch`; tests inject fixtures. */
  fetchPage?: FetchPage;
  /** The running weekly scheduler (#34); tests may inject a fake to observe `reschedule`. */
  scheduler?: SchedulerPort;
  /** Env for sink credentials (TRELLO_*); defaults to process.env. Tests pass `{}` or fixtures. */
  env?: Env;
  /** Fetch used by sinks; defaults to global fetch. Tests inject a recorder. */
  fetch?: FetchLike;
}

/** What routes need from the scheduler: re-arm the weekly run when `cron_expression` changes. */
export interface SchedulerPort {
  reschedule(cronExpression: string, timezone?: string): void;
}

/** Everything a feature's routes plugin can reach. Extend here when a new port is added. */
export interface AppContext {
  db: Database.Database;
  /**
   * The LLM port. Resolved on every read: when `agent_command` changes in Settings the next
   * read returns an agent built from the new command (no restart). Read it when you run,
   * not at plugin registration. An injected `AppOptions.llm` is returned as-is.
   */
  readonly llm: LlmAgent;
  now: () => Date;
  fetchPage: FetchPage;
  /**
   * The weekly scheduler, set by src/server.ts after `startScheduler` (absent in `buildApp`
   * alone and in tests). Settings calls `reschedule` so a new cron takes effect without restart.
   */
  scheduler?: SchedulerPort;
  /** Sink env and fetch (#32); passed on to `pushShoppingList(ctx, planId)`. */
  env?: Env;
  fetch?: FetchLike;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The ports this app was built with; also passed to every FeaturePlugin as options. */
    ctx: AppContext;
  }
}

export type FeaturePlugin = FastifyPluginAsync<AppContext>;

/**
 * Feature route plugins, registered in order. Each feature module exports one
 * `FeaturePlugin` and adds it here with a single line (parallel-work friendly).
 * Today stays first (FR-17a).
 */
const FEATURES: FeaturePlugin[] = [todayRoutes, planRoutes, shoppingRoutes, dishRoutes, schoolRoutes, pantryRoutes, settingsRoutes, langRoutes];

async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export async function buildApp({ dataDir, llm, now, fetchPage, scheduler, env, fetch }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const db = openDatabase(dataDir);
  app.addHook("onClose", async () => {
    db.close();
  });
  await app.register(import("@fastify/formbody"));

  // No built-in default command here: with nothing configured buildApp runs with NoAgent
  // (FR-16) and never spawns a process, so tests stay agent-free. src/server.ts applies the
  // FR-15 `copilot -p` default via AGENT_COMMAND. A blank saved command means "not set".
  const llmFromSettings = configuredLlmAgent(() => readSetting(db, SETTING_AGENT_COMMAND)?.trim() || process.env.AGENT_COMMAND);
  const ctx: AppContext = {
    db,
    get llm() {
      return llm ?? llmFromSettings();
    },
    now: now ?? (() => new Date()),
    fetchPage: fetchPage ?? fetchPageText,
    ...(scheduler ? { scheduler } : {}),
    ...(env ? { env } : {}),
    ...(fetch ? { fetch } : {}),
  };
  app.decorate("ctx", ctx);
  for (const feature of FEATURES) await app.register(feature, ctx);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
