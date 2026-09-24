import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ROLES } from "../src/auth/permissions.js";
import { db } from "../src/db/client.js";
import { auditLogs, users } from "../src/db/schema/index.js";
import { createProject, createUser, login, userAndClient } from "./helpers.js";

describe("roles & permissions catalog", () => {
  it("exposes the 7 built-in roles with grants matching the code catalog", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const res = await client.get("/api/roles");
    expect(res.status).toBe(200);
    const keys = res.body.data.map((r: { key: string }) => r.key).sort();
    expect(keys).toEqual(["DRIVER", "FINANCE", "PROJECT_MANAGER", "SUPER_ADMIN", "TECHNICAL", "USER", "VIEWER"]);
    for (const role of res.body.data) {
      expect(role.permissions).toEqual(ROLES[role.key as keyof typeof ROLES].grants);
    }
  });

  it("denies the roles list to users without roles.read", async () => {
    const { client } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await client.get("/api/roles")).status).toBe(403);
  });

  it("merges multiple roles to the widest scope", async () => {
    const u = await createUser(["DRIVER", "VIEWER"]);
    const c = await login(u.email);
    const me = await c.get("/api/auth/me");
    expect(me.body.data.permissions["vehicles.read"]).toBe("PROJECT");
    expect(me.body.data.permissions["projects.read"]).toBe("PROJECT");
  });
});

describe("user management", () => {
  it("lets SUPER_ADMIN create a user with a one-time temporary password", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const res = await client.post("/api/users", { name: "موظف جديد", email: "New.Person@Example.test", roleKeys: ["USER"] });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe("new.person@example.test");
    expect(res.body.data).not.toHaveProperty("passwordHash");
    expect(res.body.temporaryPassword).toBeTruthy();
    const [row] = await db.select().from(users).where(eq(users.id, res.body.data.id));
    expect(row!.mustChangePassword).toBe(true);
    expect(row!.passwordHash).not.toContain(res.body.temporaryPassword);
    // new user can log in but must change the password
    const c = await login("new.person@example.test", res.body.temporaryPassword);
    expect((await c.get("/api/dashboard")).body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("rejects duplicate emails (case-insensitive) with 409", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const existing = await createUser(["USER"]);
    const res = await client.post("/api/users", { name: "مكرر", email: existing.email.toUpperCase(), roleKeys: ["USER"] });
    expect(res.status).toBe(409);
  });

  it("denies user management to every non-admin role", async () => {
    for (const role of ["PROJECT_MANAGER", "FINANCE", "TECHNICAL", "USER", "DRIVER", "VIEWER"] as const) {
      const { client } = await userAndClient([role]);
      const res = await client.post("/api/users", { name: "x y", email: `x-${role}@example.test`, roleKeys: ["USER"] });
      expect(res.status, role).toBe(403);
    }
  });

  it("ignores/rejects client-supplied privileged fields", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const target = await createUser(["USER"]);
    const res = await client.patch(`/api/users/${target.id}`, { name: "اسم", organizationId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
  });

  it("prevents admins from changing their own roles or disabling themselves", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    expect((await client.put(`/api/users/${user.id}/roles`, { roleKeys: ["USER"] })).status).toBe(400);
    expect((await client.patch(`/api/users/${user.id}`, { status: "DISABLED" })).status).toBe(400);
  });

  it("changes roles, audits it, and applies new permissions immediately", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const target = await createUser(["VIEWER"]);
    const tc = await login(target.email);
    expect((await tc.get("/api/audit-logs")).status).toBe(403);
    const res = await client.put(`/api/users/${target.id}/roles`, { roleKeys: ["SUPER_ADMIN"] });
    expect(res.status).toBe(200);
    expect((await tc.get("/api/audit-logs")).status).toBe(200);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entityId, target.id));
    expect(logs.some((l) => l.action === "USER_ROLES_CHANGED")).toBe(true);
  });

  it("disabling a user revokes their sessions immediately", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const target = await createUser(["USER"]);
    const tc = await login(target.email);
    expect((await client.patch(`/api/users/${target.id}`, { status: "DISABLED" })).status).toBe(200);
    expect((await tc.get("/api/auth/me")).status).toBe(401);
  });

  it("admin password reset returns a temp password and revokes sessions", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const target = await createUser(["USER"]);
    const tc = await login(target.email);
    const res = await client.post(`/api/users/${target.id}/reset-password`);
    expect(res.status).toBe(200);
    expect((await tc.get("/api/auth/me")).status).toBe(401);
    await expect(login(target.email, res.body.data.temporaryPassword)).resolves.toBeDefined();
  });

  it("PROJECT_MANAGER sees only co-members of their projects", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const member = await createUser(["USER"]);
    const stranger = await createUser(["USER"]);
    await createProject({ managerId: pm.id, members: [member.id] });
    const c = await login(pm.email);
    const res = await c.get("/api/users?pageSize=100");
    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(member.id);
    expect(ids).toContain(pm.id);
    expect(ids).not.toContain(stranger.id);
    expect((await c.get(`/api/users/${stranger.id}`)).status).toBe(404);
  });

  it("validates ids to avoid malformed-id errors", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    expect((await client.get("/api/users/not-a-uuid")).status).toBe(400);
  });
});
