import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { schemaStatus } from "./db/migrations.js";
import { startEmailDispatcher } from "./email/service.js";
import { beginShutdown } from "./lib/lifecycle.js";
import { logger } from "./lib/logger.js";
import { startJobScheduler, stopJobScheduler } from "./services/jobs.js";

const app = createApp();
if (!config.DISABLE_JOBS) startJobScheduler();
// Email outbox sender (independent of DISABLE_JOBS; EMAIL_QUEUE_INTERVAL_SECONDS=0 turns it off).
const emailTimer = startEmailDispatcher();
const server = app.listen(config.PORT, () => {
  logger.info(`API listening on :${config.PORT}`, { env: config.NODE_ENV, storage: config.STORAGE_PROVIDER, trustProxy: config.TRUST_PROXY });
});
// Slow clients must not keep sockets open forever (the reverse proxy times out first in normal operation).
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

// Never run silently on an unmigrated database: /api/readyz reports 503 and the log says why.
void schemaStatus(pool)
  .then((s) => {
    if (!s.ok) logger.error(`DATABASE NOT MIGRATED — missing tables: ${s.missingTables.join(", ")}. Run "npm run db:setup" (or start with "npm run start:render").`);
  })
  .catch((e: unknown) => logger.error("cannot check database schema", { err: e }));

let closing = false;
/**
 * Graceful stop: /api/readyz turns 503 at once (the proxy stops sending traffic), no new connections are
 * accepted, in-flight requests finish, timers stop, the pool drains; a hard exit follows after the grace period.
 */
function shutdown(signal: string, exitCode = 0) {
  if (closing) return;
  closing = true;
  beginShutdown();
  logger.info(`${signal} received, shutting down`);
  stopJobScheduler();
  if (emailTimer) clearInterval(emailTimer);
  const force = setTimeout(() => {
    logger.error("shutdown timed out, exiting");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_SECONDS * 1000);
  force.unref();
  server.close(() => {
    void pool
      .end()
      .catch(() => undefined)
      .finally(() => process.exit(exitCode));
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// A stray rejected promise (usually a fire-and-forget task) is logged and counted, it must not take the service down.
process.on("unhandledRejection", (reason) => logger.error("unhandled promise rejection", { err: reason }));
// An uncaught exception leaves the process in an unknown state: log it, stop gracefully, let systemd restart it.
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { err });
  shutdown("uncaughtException", 1);
});
