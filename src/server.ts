import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
// The Docker image sets DATA_DIR=/data; the default here is for local development.
const dataDir = process.env.DATA_DIR ?? "./data";

const app = await buildApp({ dataDir });
await app.listen({ port, host: "0.0.0.0" });
