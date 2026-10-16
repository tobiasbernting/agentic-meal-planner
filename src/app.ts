import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { openDatabase, readSetting } from "./db.js";
import { createLlmAgent } from "./llm/index.js";
import type { LlmAgent } from "./llm/types.js";
import type { FetchPage } from "./plugins/schools/index.js";
import { todayRoutes } from "./today/routes.js";
import { dishRoutes } from "./dishes/routes.js";
import { schoolRoutes } from "./schools/routes.js";
import { pantryRoutes } from "./pantry/routes.js";

export interface AppOptions {
  dataDir: string;
  /** Override the LLM port (tests pass a ScriptedLlmAgent). Defaults from `agent_command`. */
  llm?: LlmAgent;
  /** Clock; tests inject a fixed date. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Fetches a web page as text (menu/recipe pages). Defaults to global `fetch`; tests inject fixtures. */
  fetchPage?: FetchPage;
}

/** Everything a feature's routes plugin can reach. Extend here when a new port is added. */
export interface AppContext {
  db: Database.Database;
  llm: LlmAgent;
  now: () => Date;
  fetchPage: FetchPage;
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
const FEATURES: FeaturePlugin[] = [todayRoutes, dishRoutes, schoolRoutes, pantryRoutes];

async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export async function buildApp({ dataDir, llm, now, fetchPage }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const db = openDatabase(dataDir);
  app.addHook("onClose", async () => {
    db.close();
  });
  await app.register(import("@fastify/formbody"));

  // No built-in default command: with nothing configured the app runs with NoAgent
  // (FR-16) and never spawns a process. DESIGN.md's `copilot -p` default is a deployment choice.
  const ctx: AppContext = {
    db,
    llm: llm ?? createLlmAgent(readSetting(db, "agent_command") ?? process.env.AGENT_COMMAND),
    now: now ?? (() => new Date()),
    fetchPage: fetchPage ?? fetchPageText,
  };
  app.decorate("ctx", ctx);
  for (const feature of FEATURES) await app.register(feature, ctx);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
