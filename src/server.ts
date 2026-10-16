import { buildApp } from "./app.js";
import { readSchedulerOptions, startScheduler } from "./scheduler/scheduler.js";
import { buildShoppingList } from "./shopping/build.js";
import { pushShoppingList } from "./sinks/push.js";

const port = Number(process.env.PORT ?? 8080);
// The Docker image sets DATA_DIR=/data; the default here is for local development.
const dataDir = process.env.DATA_DIR ?? "./data";

const app = await buildApp({ dataDir });
await app.listen({ port, host: "0.0.0.0" });

// The weekly run (FR-9) lives in the server process, not in buildApp, so tests never start cron.
// `app.ctx` itself is the deps object so `deps.llm` goes through the getter (#35: agent_command without restart).
// After a plan is stored, build its Shopping List (FR-11).
const scheduler = startScheduler(
  {
    get db() {
      return app.ctx.db;
    },
    get fetchPage() {
      return app.ctx.fetchPage;
    },
    get now() {
      return app.ctx.now;
    },
    get llm() {
      return app.ctx.llm;
    },
    afterPlan: async (planId) => {
      await buildShoppingList(app.ctx, planId);
      await pushShoppingList(app.ctx, planId); // FR-13: Buy section to sinks; never throws
    },
  },
  readSchedulerOptions(app.ctx.db),
);
// Settings (#35) re-arms the schedule through this port when `cron_expression` is saved.
app.ctx.scheduler = scheduler;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  });
}
