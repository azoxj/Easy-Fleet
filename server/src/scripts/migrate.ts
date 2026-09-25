import { config } from "../config.js";
import { pool } from "../db/client.js";
import { describeDatabase, runMigrations } from "../db/migrations.js";

console.log(`[migrate] target: ${describeDatabase(config.DATABASE_URL)}`);
try {
  await runMigrations(pool);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
