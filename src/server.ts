import { buildApp } from "./app.js";
import { readSchedulerOptions, startScheduler } from "./scheduler/scheduler.js";

const port = Number(process.env.PORT ?? 8080);
// The Docker image sets DATA_DIR=/data; the default here is for local development.
const dataDir = process.env.DATA_DIR ?? "./data";

const app = await buildApp({ dataDir });
await app.listen({ port, host: "0.0.0.0" });

// The weekly run (FR-9) lives in the server process, not in buildApp, so tests never start cron.
const scheduler = startScheduler(app.ctx, readSchedulerOptions(app.ctx.db));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  });
}
