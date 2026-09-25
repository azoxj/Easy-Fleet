import { execFileSync } from "node:child_process";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "./helpers.js";

describe("deployment probes", () => {
  it("/api/healthz is a DB-free liveness probe that leaks nothing", async () => {
    const r = await request(app).get("/api/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok" });
    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
  });

  it("/api/readyz checks the database and storage and returns booleans only", async () => {
    const r = await request(app).get("/api/readyz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ready", checks: { database: true, storage: true } });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("postgres");
    expect(text).not.toContain(process.env.STORAGE_DIR ?? "__none__");
  });
});

describe("production configuration guard", () => {
  const tsx = path.resolve("../node_modules/.bin/tsx");
  const run = (env: Record<string, string>) =>
    execFileSync(tsx, ["tests/fixtures/print-config.ts"], {
      env: { PATH: process.env.PATH!, DATABASE_URL: "postgres://u:p@localhost:5432/x", NODE_ENV: "production", COOKIE_SECURE: "true", ...env },
      encoding: "utf8",
      stdio: "pipe",
    });

  it("refuses to start in production without an https APP_ORIGINS or secure cookies", () => {
    expect(() => run({ APP_ORIGINS: "http://localhost:5173" })).toThrow(/APP_ORIGINS must list the public https origin/);
    expect(() => run({ APP_ORIGINS: "https://fleet.example", COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
  });

  it("uses the Render service URL (RENDER_EXTERNAL_URL) as default origin, and STORAGE_ROOT for storage", () => {
    const out = run({ RENDER_EXTERNAL_URL: "https://easy-fleet.onrender.com", STORAGE_ROOT: "/var/data/storage" });
    expect(out.trim()).toBe("CONFIG_OK https://easy-fleet.onrender.com /var/data/storage https://easy-fleet.onrender.com");
    expect(run({ RENDER_EXTERNAL_URL: "https://easy-fleet.onrender.com", APP_ORIGINS: "", PUBLIC_APP_URL: "" }).trim()).toBe("CONFIG_OK https://easy-fleet.onrender.com ./storage https://easy-fleet.onrender.com");
    expect(run({ APP_ORIGINS: "https://fleet.example/,https://preview.example" }).trim()).toBe("CONFIG_OK https://fleet.example,https://preview.example ./storage https://fleet.example");
  });
});
