import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Apps built without an injected logger use Fastify's pino; keep the test output quiet.
    env: { LOG_LEVEL: "silent" },
  },
});
