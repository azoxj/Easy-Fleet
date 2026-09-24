import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) throw new Error("TEST_DATABASE_URL must point to a disposable test database");
if (testDb === process.env.DATABASE_URL && !/test/i.test(testDb)) {
  throw new Error("Refusing to run tests against a non-test database");
}

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
    },
  },
});
