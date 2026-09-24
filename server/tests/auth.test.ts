import { and, desc, eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, sessions } from "../src/db/schema/index.js";
import { app, createUser, login, PASSWORD } from "./helpers.js";

describe("authentication", () => {
  it("logs in and sets a hardened session cookie", async () => {
    const u = await createUser(["USER"]);
    const res = await request(app).post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^ef_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it("stores only a hash of the session token", async () => {
    const u = await createUser(["USER"]);
    const res = await request(app).post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    const raw = /ef_session=([^;]+)/.exec((res.headers["set-cookie"] as unknown as string[])[0]!)![1]!;
    const rows = await db.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toEqual(raw);
    expect(rows[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts the email case-insensitively", async () => {
    const u = await createUser(["USER"]);
    const res = await request(app).post("/api/auth/login").send({ email: u.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("returns the same generic error for wrong password and unknown email", async () => {
    const u = await createUser(["USER"]);
    const a = await request(app).post("/api/auth/login").send({ email: u.email, password: "Wrong-Passw0rd" });
    const b = await request(app).post("/api/auth/login").send({ email: "nobody@example.test", password: "Wrong-Passw0rd" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toEqual(b.body.error.message);
  });

  it("rejects disabled users", async () => {
    const u = await createUser(["USER"], { status: "DISABLED" });
    const res = await request(app).post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rate-limits repeated failures for one account", async () => {
    const u = await createUser(["USER"]);
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/api/auth/login").send({ email: u.email, password: "Wrong-Passw0rd" });
      expect(r.status).toBe(401);
    }
    const blocked = await request(app).post("/api/auth/login").send({ email: u.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("rate-limits login attempts per IP", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await request(app).post("/api/auth/login").send({ email: `x${i}@example.test`, password: "Wrong-Passw0rd" })).status;
    }
    expect(last).toBe(429);
  });

  it("requires a session for protected routes", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/vehicles")).status).toBe(401);
    expect((await request(app).get("/api/vehicles").set("Cookie", "ef_session=forged")).status).toBe(401);
  });

  it("returns the current user with roles and effective permissions", async () => {
    const u = await createUser(["PROJECT_MANAGER"]);
    const c = await login(u.email);
    const me = await c.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toEqual(["PROJECT_MANAGER"]);
    expect(me.body.data.permissions["vehicles.read"]).toBe("PROJECT");
    expect(me.body.data.permissions["users.manage"]).toBeUndefined();
    expect(me.body.data).not.toHaveProperty("passwordHash");
  });

  it("revokes the session on logout", async () => {
    const u = await createUser(["USER"]);
    const c = await login(u.email);
    expect((await c.post("/api/auth/logout")).status).toBe(204);
    expect((await c.get("/api/auth/me")).status).toBe(401);
  });

  it("rejects state-changing requests without a valid CSRF token", async () => {
    const u = await createUser(["USER"]);
    const c = await login(u.email);
    const noToken = await c.agent.post("/api/notifications/read-all");
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe("CSRF");
    const badToken = await c.agent.post("/api/notifications/read-all").set("X-CSRF-Token", "nope");
    expect(badToken.status).toBe(403);
    expect((await c.post("/api/notifications/read-all")).status).toBe(204);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const u = await createUser(["USER"]);
    const c = await login(u.email);
    const res = await c.agent.post("/api/notifications/read-all").set("X-CSRF-Token", c.csrf).set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    const site = await c.agent.post("/api/notifications/read-all").set("X-CSRF-Token", c.csrf).set("Sec-Fetch-Site", "cross-site");
    expect(site.status).toBe(403);
    const loginCsrf = await request(app).post("/api/auth/login").set("Origin", "https://evil.example").send({ email: u.email, password: PASSWORD });
    expect(loginCsrf.status).toBe(403);
  });

  it("forces a password change when required and signs out other sessions", async () => {
    const u = await createUser(["USER"], { mustChangePassword: true });
    const other = await login(u.email);
    const c = await login(u.email);
    const blocked = await c.get("/api/vehicles");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const weak = await c.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "weak" });
    expect(weak.status).toBe(400);
    const wrong = await c.post("/api/auth/change-password", { currentPassword: "Wrong-Passw0rd", newPassword: "Brand-New-Pass1" });
    expect(wrong.status).toBe(400);
    const ok = await c.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "Brand-New-Pass1" });
    expect(ok.status).toBe(204);

    expect((await c.get("/api/vehicles")).status).toBe(200);
    expect((await other.get("/api/auth/me")).status).toBe(401);
    await expect(login(u.email, PASSWORD)).rejects.toThrow();
    await expect(login(u.email, "Brand-New-Pass1")).resolves.toBeDefined();
  });

  it("writes audit records for login, failed login and logout", async () => {
    const u = await createUser(["USER"]);
    await request(app).post("/api/auth/login").send({ email: u.email, password: "Wrong-Passw0rd" });
    const c = await login(u.email);
    await c.post("/api/auth/logout");
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.userId, u.id)).orderBy(desc(auditLogs.id));
    expect(rows.map((r) => r.action)).toEqual(["AUTH_LOGOUT", "AUTH_LOGIN", "AUTH_LOGIN_FAILED"]);
    expect(rows[1]!.ip).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain("Wrong-Passw0rd");
    const [failed] = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, u.id), eq(auditLogs.action, "AUTH_LOGIN_FAILED")));
    expect(failed!.metadata).toEqual({ reason: "bad_password" });
  });

  it("expires idle sessions", async () => {
    const u = await createUser(["USER"]);
    const c = await login(u.email);
    await db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(sessions.userId, u.id));
    expect((await c.get("/api/auth/me")).status).toBe(401);
  });
});

describe("http hardening", () => {
  it("sets security headers and hides the framework", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns JSON errors for malformed and oversized bodies", async () => {
    const bad = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_JSON");
    const big = await request(app).post("/api/auth/login").send({ email: "a@b.c", password: "x".repeat(200_000) });
    expect(big.status).toBe(413);
  });

  it("returns 404 JSON for unknown API routes (authenticated)", async () => {
    const u = await createUser(["USER"]);
    const c = await login(u.email);
    const res = await c.get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
