import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { openDatabase, readSetting } from "./db.js";
import { configuredLlmAgent } from "./llm/index.js";
import type { LlmAgent } from "./llm/types.js";
import { DEFAULT_CRON_EXPRESSION, SETTING_AGENT_COMMAND, SETTING_CRON_EXPRESSION, SETTING_TIMEZONE } from "./planner/settings.js";
import { prettyStdout, resolveLogLevel, type LogThreshold } from "./logging/config.js";
import { LogBuffer } from "./logging/buffer.js";
import { createPino, teeLogger, type LevelGate, type LogControl, type LogDestination } from "./logging/destinations.js";
import { pinoLogger, type Logger } from "./logging/logger.js";
import { runWithRunId } from "./logging/run-context.js";
import { agentBinaryFound, startupReport } from "./logging/startup.js";
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
import { logsRoutes } from "./logs/routes.js";
import { createPlanRunRegistry, type PlanRunRegistry } from "./plan-run/registry.js";
import { planRunRoutes } from "./plan-run/routes.js";
import { moreRoutes } from "./more/routes.js";
import { assetRoutes } from "./ui/assets.js";

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
  /**
   * Logger port (spec #42). Tests inject `createCapturingLogger().logger`. Without one, Fastify's
   * pino logger is used: level from LOG_LEVEL, JSON lines in production, pino-pretty otherwise.
   */
  logger?: Logger;
  /** Starting log level; defaults from LOG_LEVEL (`debug` with an injected `logger`). */
  logLevel?: LogThreshold;
  /** Where the stdout copy of the JSON lines goes (no pretty-printing); tests collect lines. */
  logDestination?: LogDestination;
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
  /** The app logger. Bind a run with `runLogger(ctx.log, req, component)`; pass it on as `log` in deps. */
  log: Logger;
  /**
   * The configured agent command (Settings value, else AGENT_COMMAND), re-read on every access;
   * undefined when none is set. The same resolution the `llm` getter uses.
   */
  readonly agentCommand: string | undefined;
  /** The Logs page's buffer (last 2000 records, as on stdout) and the live level (#47). */
  logs: LogControl;
  /** In-flight Plan Runs and each week's last outcome (spec #61); in memory, forgotten on restart. */
  planRuns: PlanRunRegistry;
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
const FEATURES: FeaturePlugin[] = [todayRoutes, planRoutes, shoppingRoutes, dishRoutes, schoolRoutes, pantryRoutes, settingsRoutes, logsRoutes, planRunRoutes, langRoutes, moreRoutes, assetRoutes];

async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/** Startup self-check (spec #42): one `startup` record, plus a warn when the agent binary is missing. */
function logStartup(log: Logger, db: Database.Database, dataDir: string, agentCommand: string | undefined): void {
  const timezone = readSetting(db, SETTING_TIMEZONE);
  const report = startupReport({
    agentCommand,
    env: process.env,
    cronExpression: readSetting(db, SETTING_CRON_EXPRESSION) ?? DEFAULT_CRON_EXPRESSION,
    dataDir,
    ...(timezone ? { timezone } : {}),
  });
  const startup = log.child({ component: "startup" });
  startup.info({ ...report }, "startup");
  if (report.agentCommand && !report.agentBinaryFound) {
    startup.warn({ agentCommand: report.agentCommand, agentBinary: report.agentBinary, agentBinaryFound: false }, "agent binary not found on PATH; plans will be degraded");
  } else if (!report.agentCommand) {
    startup.info({}, "no agent configured; plans run in degraded mode");
  }
}

/** The app's Logger and its LogControl: pino to stdout and the buffer, or the injected logger teed into it. */
async function appLogging(options: Pick<AppOptions, "logger" | "logLevel" | "logDestination">): Promise<{ pino?: FastifyBaseLogger; log: Logger; logs: LogControl }> {
  const buffer = new LogBuffer();
  if (options.logger) {
    const gate: LevelGate = { level: options.logLevel ?? "debug" };
    const logs: LogControl = { buffer, getLevel: () => gate.level, setLevel: (level) => void (gate.level = level) };
    return { log: teeLogger(options.logger, buffer, gate), logs };
  }
  const pino = await createPino({
    level: options.logLevel ?? resolveLogLevel(process.env),
    buffer,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
    pretty: prettyStdout(process.env),
  });
  // Children follow the root's level unless given their own, so this reaches every run logger.
  const logs: LogControl = { buffer, getLevel: () => pino.level as LogThreshold, setLevel: (level) => void (pino.level = level) };
  return { pino, log: pinoLogger(pino), logs };
}

export async function buildApp({ dataDir, llm, now, fetchPage, scheduler, env, fetch, logger, logLevel, logDestination }: AppOptions): Promise<FastifyInstance> {
  const { pino, log, logs } = await appLogging({ logger, logLevel, logDestination });
  // Request lines come from the hooks below (with `runId`), not from Fastify's own request logging.
  const app = pino
    ? Fastify({ loggerInstance: pino, logController: new LogController({ disableRequestLogging: true }) })
    : Fastify({ logger: false });
  // The request's handlers, and everything they await, run under its id (shared loggers tag records with it).
  app.addHook("onRequest", (req, _reply, done) => runWithRunId(req.id, done));
  app.addHook("onRequest", async (req) => {
    log.info({ runId: req.id, method: req.method, url: req.url }, "incoming request");
  });
  app.addHook("onResponse", async (req, reply) => {
    log.info({ runId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) }, "request completed");
  });
  const db = openDatabase(dataDir);
  app.addHook("onClose", async () => {
    db.close();
  });
  await app.register(import("@fastify/formbody"));

  // No built-in default command here: with nothing configured buildApp runs with NoAgent
  // (FR-16) and never spawns a process, so tests stay agent-free. src/server.ts applies the
  // FR-15 `copilot -p` default via AGENT_COMMAND. A blank saved command means "not set".
  const readAgentCommand = () => (readSetting(db, SETTING_AGENT_COMMAND)?.trim() || process.env.AGENT_COMMAND)?.trim() || undefined;
  const llmFromSettings = configuredLlmAgent(readAgentCommand, { log: log.child({ component: "llm" }) });
  const ctx: AppContext = {
    db,
    log,
    logs,
    planRuns: createPlanRunRegistry(),
    get agentCommand() {
      return readAgentCommand();
    },
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

  // PATH lookup only; the agent is never called here.
  app.get("/health", async () => {
    const agentCommand = ctx.agentCommand;
    return { status: "ok", agentBinaryFound: agentBinaryFound(agentCommand, process.env), agentCommand: agentCommand ?? null };
  });

  logStartup(log, db, dataDir, ctx.agentCommand);

  return app;
}
