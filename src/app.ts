import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { openDatabase } from "./db.js";
import { page } from "./ui/layout.js";
import { dishRoutes } from "./dishes/routes.js";
import { schoolRoutes } from "./schools/routes.js";

export interface AppOptions {
  dataDir: string;
}

/** Everything a feature's routes plugin can reach. Extend here when a new port is added. */
export interface AppContext {
  db: Database.Database;
}

export type FeaturePlugin = FastifyPluginAsync<AppContext>;

/**
 * Feature route plugins, registered in order. Each feature module exports one
 * `FeaturePlugin` and adds it here with a single line (parallel-work friendly).
 */
const FEATURES: FeaturePlugin[] = [dishRoutes, schoolRoutes];

const homeRoutes: FeaturePlugin = async (app) => {
  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return page({ title: "Today", body: "<h1>Meal Planner</h1>" });
  });
};

export async function buildApp({ dataDir }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const db = openDatabase(dataDir);
  app.addHook("onClose", async () => {
    db.close();
  });
  await app.register(import("@fastify/formbody"));

  const ctx: AppContext = { db };
  await app.register(homeRoutes, ctx);
  for (const feature of FEATURES) await app.register(feature, ctx);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
