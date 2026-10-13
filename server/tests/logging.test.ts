import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { errorHandler } from "../src/http/errors.js";
import { requestLog } from "../src/http/request-log.js";
import { logger, redact, redactString, safePath } from "../src/lib/logger.js";
import { app } from "./helpers.js";

const TOKEN = "Zk3pQ9vXw2LmN8aB5cD7eF1gH4jK6rS0tUyVx"; // 38 chars, looks like a handover token
let out: string[] = [];
const saved = { ...config } as Record<string, unknown>;

beforeEach(() => {
  out = [];
  const grab = (c: unknown) => (out.push(String(c)), true);
  vi.spyOn(process.stdout, "write").mockImplementation(grab as never);
  vi.spyOn(process.stderr, "write").mockImplementation(grab as never);
  Object.assign(config, { LOG_REQUESTS: true, LOG_FORMAT: "json", LOG_LEVEL: "info" });
});
afterEach(() => {
  Object.assign(config, { LOG_REQUESTS: saved.LOG_REQUESTS, LOG_FORMAT: saved.LOG_FORMAT, LOG_LEVEL: saved.LOG_LEVEL });
  vi.restoreAllMocks();
});
const lines = () => out.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("redaction", () => {
  it("removes credentials, tokens and secret-looking keys; keeps the rest", () => {
    expect(redactString("connect postgres://admin:s3cr3t@db.example.com:5432/app failed")).toBe("connect postgres://***@db.example.com:5432/app failed");
    expect(redactString(`GET /h/${TOKEN}`)).toBe("GET /h/[redacted]");
    expect(redactString(`/api/public/handover/${TOKEN}/photos/FRONT`)).toBe("/api/public/handover/[redacted]/photos/FRONT");
    expect(redactString("Authorization: Bearer abcdefghijklmnop123")).toContain("Bearer [redacted]");
    expect(redactString("https://fleet.example.com/reset-password#token=AbC123_-xyz")).toBe("https://fleet.example.com/reset-password#token=[redacted]");
    const r = redact({ user: "u1", password: "x", apiSecret: "y", nested: { sessionId: "z", cookie: "c", DATABASE_URL: "postgres://a:b@h/d", ok: "fine" }, list: [{ token: "t" }] }) as Record<string, unknown>;
    expect(JSON.stringify(r)).not.toMatch(/"x"|"y"|"z"|"c"|a:b|"t"/);
    expect(r).toMatchObject({ user: "u1", nested: { ok: "fine" } });
  });

  it("safePath drops the query string and any handover token", () => {
    expect(safePath(`/h/${TOKEN}?utm=1&x=2`)).toBe("/h/[redacted]");
    expect(safePath("/api/vehicles?page=2")).toBe("/api/vehicles");
  });

  it("logger output is one JSON line per event and never contains what was redacted", () => {
    logger.error("db failed", { err: new Error("could not connect to postgres://admin:topsecret@db/x"), password: "hunter2", requestId: "r-1" });
    const [l] = lines();
    expect(l).toMatchObject({ level: "error", msg: "db failed", requestId: "r-1", password: "[REDACTED]" });
    expect(JSON.stringify(l)).not.toMatch(/topsecret|hunter2/);
  });

  it("respects LOG_LEVEL", () => {
    Object.assign(config, { LOG_LEVEL: "warn" });
    logger.info("quiet");
    logger.warn("loud");
    expect(lines().map((l) => l.msg)).toEqual(["loud"]);
  });
});

describe("request log and request IDs", () => {
  it("logs one structured line per request with the token redacted and no query, cookie or header", async () => {
    const r = await request(app)
      .get(`/api/public/handover/${TOKEN}?secret=1`)
      .set("Cookie", "__Host-ef_session=SESSIONSECRET123")
      .set("Referer", `https://x.example/h/${TOKEN}`);
    expect(r.status).toBe(404);
    const text = out.join("");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("SESSIONSECRET123");
    expect(text).not.toContain("secret=1");
    const l = lines().find((x) => x.msg === "request")!;
    expect(l).toMatchObject({ method: "GET", path: "/api/public/handover/[redacted]", status: 404 });
    expect(typeof l.ms).toBe("number");
    expect(l.requestId).toBe(r.headers["x-request-id"]);
  });

  it("a well-formed X-Request-Id from the proxy is kept; a malformed one is replaced", async () => {
    const ok = await request(app).get("/api/healthz").set("X-Request-Id", "abcd1234-edge-req");
    expect(ok.headers["x-request-id"]).toBe("abcd1234-edge-req");
    const bad = await request(app).get("/api/healthz").set("X-Request-Id", "<script>alert(1)</script>");
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(bad.headers["x-request-id"]).not.toContain("script");
  });

  it("health probes are not logged when healthy; failures are logged at the right level", async () => {
    await request(app).get("/api/healthz");
    expect(lines().filter((l) => l.msg === "request")).toHaveLength(0);
    await request(app).get("/api/does-not-exist");
    expect(lines().find((l) => l.msg === "request")).toMatchObject({ level: "warn", status: 401 });
  });

  it("an unexpected error carries one error id in the response and in the log, without secrets", async () => {
    const a = express();
    a.use(requestLog);
    a.get("/boom", () => {
      throw new Error(`failed with postgres://admin:topsecret@db/x and /h/${TOKEN}`);
    });
    a.use(errorHandler);
    const id = randomUUID();
    const r = await request(a).get("/boom").set("X-Request-Id", id);
    expect(r.status).toBe(500);
    const errorLine = lines().find((l) => l.msg === "unhandled error")!;
    expect(errorLine).toMatchObject({ level: "error", errorId: r.body.error.errorId, requestId: id });
    expect(out.join("")).not.toMatch(/topsecret|Zk3pQ9vXw2LmN8/);
    expect(JSON.stringify(r.body)).not.toMatch(/topsecret|postgres/);
  });

  it("with LOG_REQUESTS off there is no request line, but the request id still works", async () => {
    Object.assign(config, { LOG_REQUESTS: false });
    const r = await request(app).get("/api/does-not-exist");
    expect(lines().filter((l) => l.msg === "request")).toHaveLength(0);
    expect(r.headers["x-request-id"]).toBeTruthy();
  });
});
