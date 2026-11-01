import { describe, expect, it } from "vitest";
import { assertNotDesignated, assertSafeTestDatabase, DESIGNATION_COMMENT, testDatabaseProblem } from "./support/db-guard.js";

const ok = (url: string, env: Record<string, string | undefined> = {}) => testDatabaseProblem(url, env);

describe("destructive-test database guard", () => {
  it("accepts local, test-named databases (including a CI host that is allowed explicitly)", () => {
    expect(ok("postgres://u:p@localhost:5432/easy_fleet_test")).toBeNull();
    expect(ok("postgres://u:p@127.0.0.1/ef_phase1_test")).toBeNull();
    expect(ok("postgres://u:p@[::1]:5432/ef_test")).toBeNull();
    expect(ok("postgres://u:p@pgservice:5432/ef_test", { EF_TEST_DB_ALLOWED_HOSTS: "pgservice" })).toBeNull();
  });

  it("refuses RDS, Render and other cloud hosts even when the database name contains test", () => {
    for (const host of ["easyfleet.abc123.me-central-1.rds.amazonaws.com", "x.render.com", "dpg-abc.oregon-postgres.render.com", "db.supabase.co", "ep-1.neon.tech", "prod-db.internal", "pg.production.example.com"]) {
      expect(ok(`postgres://u:p@${host}:5432/easyfleet_test`), host).toMatch(/cloud or production|not local/);
    }
  });

  it("refuses an allowed-looking host list that still names a cloud host", () => {
    expect(ok("postgres://u:p@x.rds.amazonaws.com/ef_test", { EF_TEST_DB_ALLOWED_HOSTS: "x.rds.amazonaws.com" })).toMatch(/cloud or production/);
  });

  it("refuses non-local hosts that were not allowed, and databases not named test", () => {
    expect(ok("postgres://u:p@db.internal.example:5432/ef_test")).toMatch(/not local/);
    expect(ok("postgres://u:p@localhost/easyfleet")).toMatch(/not named as a test/);
    expect(ok("postgres://u:p@localhost/easyfleet_production")).toMatch(/not named as a test|production/);
    expect(ok("postgres://u:p@localhost/test_production")).toMatch(/production-like/);
    expect(ok("postgres://u:p@localhost/ef_test", { EF_PRODUCTION_DB_NAMES: "ef_test" })).toMatch(/designated production/);
  });

  it("refuses a missing or unparseable URL and NODE_ENV=production", () => {
    expect(testDatabaseProblem(undefined, {})).toMatch(/not set/);
    expect(ok("not a url")).toMatch(/cannot be parsed/);
    expect(ok("postgres://u:p@localhost/ef_test", { NODE_ENV: "production" })).toMatch(/NODE_ENV/);
  });

  it("refuses when TEST_DATABASE_URL is safe but the environment's DATABASE_URL points at production", () => {
    expect(ok("postgres://u:p@localhost/ef_test", { DATABASE_URL: "postgres://u:p@x.rds.amazonaws.com/easyfleet_production" })).toMatch(/DATABASE_URL/);
    expect(ok("postgres://u:p@localhost/ef_test", { DATABASE_URL: "postgres://u:p@localhost/ef_test" })).toBeNull();
  });

  it("the thrown error says nothing was connected and never prints the URL or password", () => {
    const url = "postgres://admin:SuperSecret@x.rds.amazonaws.com:5432/easyfleet_test";
    let msg = "";
    try {
      assertSafeTestDatabase(url, {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Refusing to run destructive database tests");
    expect(msg).toContain("Nothing was connected");
    expect(msg).not.toContain("SuperSecret");
  });

  it("a connected database carrying the designation comment is refused before any DROP", async () => {
    const q = (c: string | null) => async () => ({ rows: [{ c }] });
    await expect(assertNotDesignated(q(DESIGNATION_COMMENT))).rejects.toThrow(/designation/);
    await expect(assertNotDesignated(q("Production database"))).rejects.toThrow(/designation/);
    await expect(assertNotDesignated(q(null))).resolves.toBeUndefined();
    await expect(assertNotDesignated(q("scratch"))).resolves.toBeUndefined();
  });

  it("the guard really runs first: vitest.config, global-setup and setup call it before connecting", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync("vitest.config.ts", "utf8");
    expect(cfg).toContain("assertSafeTestDatabase(testDb)");
    const gs = readFileSync("tests/global-setup.ts", "utf8");
    expect(gs.indexOf("assertSafeTestDatabase(url)")).toBeGreaterThan(-1);
    expect(gs.indexOf("assertSafeTestDatabase(url)")).toBeLessThan(gs.indexOf("new pg.Pool"));
    expect(gs.indexOf("assertNotDesignated")).toBeLessThan(gs.indexOf("drop schema"));
  });
});
