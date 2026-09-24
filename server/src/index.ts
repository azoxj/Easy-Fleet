import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`[easy-fleet] API listening on :${config.PORT} (${config.NODE_ENV})`);
});

function shutdown(signal: string) {
  console.log(`[easy-fleet] ${signal} received, shutting down`);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
