import { afterAll, beforeEach } from "vitest";
import { apiLimiter } from "../src/app.js";
import { pool } from "../src/db/client.js";

beforeEach(async () => {
  apiLimiter.clear();
  // Shared (PostgreSQL) rate-limit counters.
  await pool.query("delete from rate_limits");
});

afterAll(async () => {
  await pool.end();
});
