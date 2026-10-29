import { afterAll, beforeEach } from "vitest";
import { apiLimiter } from "../src/app.js";
import { pool } from "../src/db/client.js";
import { assertSafeTestDatabase } from "./support/db-guard.js";

// Runs before every test file (and so before the files that create/drop databases on this server).
assertSafeTestDatabase();

beforeEach(async () => {
  apiLimiter.clear();
  // Shared (PostgreSQL) rate-limit counters.
  await pool.query("delete from rate_limits");
});

afterAll(async () => {
  await pool.end();
});
