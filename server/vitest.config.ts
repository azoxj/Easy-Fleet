import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { assertSafeTestDatabase } from "./tests/support/db-guard.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) throw new Error("TEST_DATABASE_URL must point to a disposable test database");
// Before anything connects: local host, test-named database, nothing production-like (see tests/support/db-guard.ts).
assertSafeTestDatabase(testDb);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // One shared database: run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testDb,
      SCRYPT_LOG_N: "12",
      APP_ORIGINS: "http://localhost:5173",
      COOKIE_SECURE: "false",
      APP_TIMEZONE: "Asia/Riyadh",
      // Uploaded files in tests go to a throwaway directory, never the repo.
      STORAGE_DIR: path.join(tmpdir(), `easy-fleet-test-storage-${process.pid}`),
      MAX_UPLOAD_MB: "1",
    },
  },
});
