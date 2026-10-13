import express from "express";
import pg from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPoolErrorHandler, pool, poolOptions } from "../src/db/client.js";
import { databaseIssue, errorHandler } from "../src/http/errors.js";
import { resetReadinessCacheForTests } from "../src/http/readiness.js";
import { beginShutdown, resetLifecycleForTests } from "../src/lib/lifecycle.js";
import { app } from "./helpers.js";

const url = () => process.env.DATABASE_URL!;
const base = { connectionString: "postgres://u:p@localhost:5432/db", max: 7, idleTimeoutMillis: 1000, connectionTimeoutMillis: 2500, statementTimeoutMs: 4000, idleInTxTimeoutMs: 6000 };

afterEach(() => {
  resetLifecycleForTests();
  resetReadinessCacheForTests();
  vi.restoreAllMocks();
});

describe("connection pool settings", () => {
  it("maps the settings to pg options (server-side timeouts, SSL modes)", () => {
    expect(poolOptions(base)).toMatchObject({ max: 7, connectionTimeoutMillis: 2500, statement_timeout: 4000, idle_in_transaction_session_timeout: 6000 });
    expect(poolOptions(base)).not.toHaveProperty("ssl");
    expect(poolOptions({ ...base, statementTimeoutMs: 0, idleInTxTimeoutMs: 0 })).not.toHaveProperty("statement_timeout");
    expect(poolOptions({ ...base, ssl: "disable" }).ssl).toBe(false);
    expect(poolOptions({ ...base, ssl: "require" }).ssl).toEqual({ rejectUnauthorized: false });
    expect(poolOptions({ ...base, ssl: "verify-full" }).ssl).toMatchObject({ rejectUnauthorized: true });
    expect(() => poolOptions({ ...base, ssl: "verify-full", sslCaFile: "/nonexistent/ca.pem" })).toThrow();
  });

  it("the application's own pool uses the configured limits", () => {
    const o = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(o).toMatchObject({ max: 10, connectionTimeoutMillis: 5000, statement_timeout: 30000, idle_in_transaction_session_timeout: 60000 });
  });

  it("an idle-client error is logged and survived; without a handler it would be fatal", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const bare = new pg.Pool({ connectionString: url() });
    expect(() => bare.emit("error", new Error("boom"))).toThrow("boom"); // what used to kill the process
    const handled = new pg.Pool({ connectionString: url() });
    const seen: Error[] = [];
    attachPoolErrorHandler(handled, (e) => seen.push(e));
    expect(() => handled.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(seen).toHaveLength(1);
    // the app's pool has the handler too
    expect(() => pool.emit("error", new Error("simulated idle client failure"))).not.toThrow();
    void bare.end();
    void handled.end();
  });
});

describe("timeouts are enforced by PostgreSQL / the pool", () => {
  it("statement_timeout cancels a slow statement and the error maps to 503 DB_TIMEOUT", async () => {
    const p = new pg.Pool(poolOptions({ ...base, connectionString: url(), statementTimeoutMs: 150 }));
    const err = await p.query("select pg_sleep(2)").catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("57014");
    expect(databaseIssue(err)).toBe("timeout");
    // the connection is still usable afterwards
    expect((await p.query("select 1 as n")).rows[0].n).toBe(1);
    await p.end();
  });

  it("idle_in_transaction_session_timeout ends an abandoned transaction", async () => {
    const p = new pg.Pool(poolOptions({ ...base, connectionString: url(), idleInTxTimeoutMs: 200 }));
    attachPoolErrorHandler(p, () => undefined);
    const c = await p.connect();
    c.on("error", () => undefined);
    await c.query("begin");
    await c.query("select 1");
    await new Promise((r) => setTimeout(r, 700));
    const err = await c.query("select 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    c.release(true);
    await p.end();
  });

  it("connectionTimeoutMillis: a request waiting for a free connection fails instead of hanging", async () => {
    const p = new pg.Pool(poolOptions({ ...base, connectionString: url(), max: 1, connectionTimeoutMillis: 200 }));
    const held = await p.connect();
    const t0 = Date.now();
    const err = await p.connect().catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((err as Error).message).toMatch(/timeout exceeded when trying to connect/);
    expect(databaseIssue(err)).toBe("unavailable");
    held.release();
    await p.end();
  });
});

describe("database failures become 503 (never a blind retry, never a leak)", () => {
  const make = (err: unknown) => {
    const a = express();
    a.get("/x", () => {
      throw err;
    });
    a.use(errorHandler);
    return a;
  };

  it("classifies connection-class failures, including wrapped causes", () => {
    for (const e of [{ code: "ECONNREFUSED" }, { code: "57P01" }, { code: "08006" }, { code: "53300" }, new Error("Connection terminated unexpectedly"), Object.assign(new Error("Failed query: select 1"), { cause: { code: "ECONNRESET" } })]) {
      expect(databaseIssue(e), JSON.stringify(e)).toBe("unavailable");
    }
    expect(databaseIssue({ code: "57014" })).toBe("timeout");
    expect(databaseIssue({ code: "23505" })).toBeNull();
    expect(databaseIssue(new Error("something else"))).toBeNull();
  });

  it("answers 503 with Retry-After, an error id and no internals", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await request(make(Object.assign(new Error("connect ECONNREFUSED 10.0.1.5:5432 postgres://admin:topsecret@db"), { code: "ECONNREFUSED" }))).get("/x");
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("5");
    expect(r.body.error).toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(r.body.error.errorId).toMatch(/^[0-9a-f]{10}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/topsecret|10\.0\.1\.5|postgres:/);
  });

  it("a real bug still answers 500 with an error id and a generic message", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await request(make(new Error("kaboom with postgres://admin:topsecret@db/x"))).get("/x");
    expect(r.status).toBe(500);
    expect(r.body.error).toMatchObject({ code: "INTERNAL" });
    expect(r.body.error.errorId).toMatch(/^[0-9a-f]{10}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/kaboom|topsecret/);
  });
});

describe("health and readiness during normal operation and shutdown", () => {
  it("healthz stays 200 and readyz is ready", async () => {
    expect((await request(app).get("/api/healthz")).status).toBe(200);
    const r = await request(app).get("/api/readyz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ready", checks: { database: true, schema: true, storage: true } });
  });

  it("readyz turns 503 at once when shutdown begins while healthz still answers", async () => {
    beginShutdown();
    const r = await request(app).get("/api/readyz");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ status: "unavailable", draining: true });
    expect((await request(app).get("/api/healthz")).status).toBe(200);
  });

  it("readiness is cheap: the schema check is reused between probes", async () => {
    const spy = vi.spyOn(pool, "query");
    resetReadinessCacheForTests();
    await request(app).get("/api/readyz");
    const first = spy.mock.calls.filter((c) => String(c[0]).includes("__drizzle_migrations")).length;
    spy.mockClear();
    await request(app).get("/api/readyz");
    await request(app).get("/api/readyz");
    const later = spy.mock.calls.filter((c) => String(c[0]).includes("__drizzle_migrations")).length;
    expect(first).toBeGreaterThan(0);
    expect(later).toBe(0);
  });

  it("a database that stops answering makes readyz 503 within the probe timeout", async () => {
    vi.spyOn(pool, "query").mockImplementation((() => new Promise(() => undefined)) as never);
    const t0 = Date.now();
    const r = await request(app).get("/api/readyz");
    expect(r.status).toBe(503);
    expect(r.body.checks.database).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4500);
  }, 10_000);
});

describe("disk space is part of readiness (the volume with logs and temporary files must not fill up)", () => {
  it("readyz is 503 when the scratch disk has less free space than DISK_MIN_FREE_MB, ready again afterwards", async () => {
    const { config } = await import("../src/config.js");
    const before = config.DISK_MIN_FREE_MB;
    try {
      (config as { DISK_MIN_FREE_MB: number }).DISK_MIN_FREE_MB = 1_000_000_000; // more than any disk has
      const r = await request(app).get("/api/readyz");
      expect(r.status).toBe(503);
      expect(r.body.checks).toEqual({ database: true, schema: true, storage: false });
    } finally {
      (config as { DISK_MIN_FREE_MB: number }).DISK_MIN_FREE_MB = before;
    }
    expect((await request(app).get("/api/readyz")).status).toBe(200);
  });
});
