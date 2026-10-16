import Fastify from "fastify";
import { openDatabase } from "./db.js";

export interface AppOptions {
  dataDir: string;
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Meal Planner</title>
  </head>
  <body>
    <h1>Meal Planner</h1>
  </body>
</html>
`;

export async function buildApp({ dataDir }: AppOptions) {
  const app = Fastify();
  const db = openDatabase(dataDir);
  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return PAGE;
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
