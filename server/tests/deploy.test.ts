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

  it("/api/readyz checks the database, the migrated schema and storage, and returns booleans only", async () => {
    const r = await request(app).get("/api/readyz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ready", checks: { database: true, schema: true, storage: true } });
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

describe("production web serving (SPA)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createApp } = await import("../src/app.js");
  const { resolveWebDist } = await import("../src/http/web-dist.js");
  const dist = mkdtempSync(path.join(tmpdir(), "ef-web-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Easy Fleet</title><div id=root></div>");
  writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log(1)");
  const web = createApp({ webDistDir: dist });

  it("GET / returns index.html", async () => {
    const r = await request(web).get("/");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.text).toContain("<title>Easy Fleet</title>");
  });

  it("client-side routes fall back to index.html; static assets are served", async () => {
    for (const p of ["/vehicles", "/finance/invoices/123", "/h/some-token", "/login"]) {
      const r = await request(web).get(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).toContain("<title>Easy Fleet</title>");
    }
    const a = await request(web).get("/assets/app-abc123.js");
    expect(a.status).toBe(200);
    expect(a.headers["cache-control"]).toContain("immutable");
  });

  it("/api and /api/* are never answered by the SPA fallback", async () => {
    const miss = await request(web).get("/api/does-not-exist");
    expect(miss.status).toBe(401); // unknown API paths still go through auth → JSON, never index.html
    expect(miss.headers["content-type"]).toContain("application/json");
    const root = await request(web).get("/api");
    expect(root.headers["content-type"] ?? "").not.toContain("text/html");
    expect((await request(web).get("/api/healthz")).body).toEqual({ status: "ok" });
  });

  it("resolves WEB_DIST_DIR against the working dir or server/, and falls back to <repo>/web/dist in production", () => {
    expect(resolveWebDist(dist, true).dir).toBe(dist);
    expect(resolveWebDist("/nonexistent-dir", false).dir).toBeNull();
    expect(resolveWebDist("/nonexistent-dir", true).tried.at(-1)).toBe(path.resolve(process.cwd(), "../web/dist")); // wrong value → repo fallback
    const fallback = resolveWebDist(undefined, true).tried[0]!;
    expect(fallback).toBe(path.resolve(process.cwd(), "../web/dist"));
    expect(resolveWebDist("../web/dist", true).tried).toContain(path.resolve(process.cwd(), "../web/dist"));
    expect(resolveWebDist(undefined, false).dir).toBeNull(); // dev/test: Vite serves the UI
  });
});
