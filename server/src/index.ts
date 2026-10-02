import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { schemaStatus } from "./db/migrations.js";
import { startEmailDispatcher } from "./email/service.js";
import { startJobScheduler } from "./services/jobs.js";

const app = createApp();
if (!config.DISABLE_JOBS) startJobScheduler();
// Email outbox sender (independent of DISABLE_JOBS; EMAIL_QUEUE_INTERVAL_SECONDS=0 turns it off).
startEmailDispatcher();
const server = app.listen(config.PORT, () => {
  console.log(`[easy-fleet] API listening on :${config.PORT} (${config.NODE_ENV})`);
});

// Never run silently on an unmigrated database: /api/readyz reports 503 and the log says why.
void schemaStatus(pool)
  .then((s) => {
    if (!s.ok) console.error(`[easy-fleet] DATABASE NOT MIGRATED — missing tables: ${s.missingTables.join(", ")}. Run "npm run db:setup" (or start with "npm run start:render").`);
  })
  .catch((e: unknown) => console.error(`[easy-fleet] cannot check database schema: ${e instanceof Error ? e.message : String(e)}`));

function shutdown(signal: string) {
  console.log(`[easy-fleet] ${signal} received, shutting down`);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
