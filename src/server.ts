import { buildApp } from "./app.js";
import { readSchedulerOptions, startScheduler } from "./scheduler/scheduler.js";
import { buildShoppingList } from "./shopping/build.js";

const port = Number(process.env.PORT ?? 8080);
// The Docker image sets DATA_DIR=/data; the default here is for local development.
const dataDir = process.env.DATA_DIR ?? "./data";

const app = await buildApp({ dataDir });
await app.listen({ port, host: "0.0.0.0" });

// The weekly run (FR-9) lives in the server process, not in buildApp, so tests never start cron.
// After a plan is stored, build its Shopping List (FR-11); `ctx.llm` is read at call time.
const scheduler = startScheduler(
  {
    db: app.ctx.db,
    fetchPage: app.ctx.fetchPage,
    now: app.ctx.now,
    get llm() {
      return app.ctx.llm;
    },
    afterPlan: async (planId) => {
      await buildShoppingList(app.ctx, planId);
    },
  },
  readSchedulerOptions(app.ctx.db),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  });
}
