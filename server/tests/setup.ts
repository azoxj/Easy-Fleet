import { afterAll, beforeEach } from "vitest";
import { apiLimiter } from "../src/app.js";
import { pool } from "../src/db/client.js";
import { loginFailLimiter, loginIpLimiter } from "../src/modules/auth/routes.js";

beforeEach(() => {
  apiLimiter.clear();
  loginIpLimiter.clear();
  loginFailLimiter.clear();
});

afterAll(async () => {
  await pool.end();
});
