import { desc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs } from "../src/db/schema/index.js";
import { audit } from "../src/services/audit.js";
import { createUser, defaultOrgId, userAndClient } from "./helpers.js";

describe("audit log", () => {
  it("is append-only at the database level (UPDATE/DELETE/TRUNCATE rejected)", async () => {
    const orgId = await defaultOrgId();
    await audit(db, null, { action: "USER_UPDATED", entity: "test", entityId: "x", orgId, userId: null });
    const [row] = await db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(1);
    await expect(db.update(auditLogs).set({ action: "TAMPERED" }).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
    await expect(db.delete(auditLogs).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
    await expect(db.execute(sql`truncate audit_logs`)).rejects.toThrow();
    const [again] = await db.select().from(auditLogs).where(eq(auditLogs.id, row!.id));
    expect(again!.action).toBe("USER_UPDATED");
  });

  it("redacts secrets from metadata", async () => {
    const orgId = await defaultOrgId();
    await audit(db, null, {
      action: "USER_UPDATED",
      entity: "redact-test",
      orgId,
      userId: null,
      metadata: { password: "p", nested: { apiToken: "t", iban: "SA00" }, safe: "ok" },
    });
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entity, "redact-test"));
    expect(row!.metadata).toEqual({ password: "[REDACTED]", nested: { apiToken: "[REDACTED]", iban: "[REDACTED]" }, safe: "ok" });
  });

  it("only SUPER_ADMIN can read the audit log; there is no delete endpoint", async () => {
    for (const role of ["PROJECT_MANAGER", "FINANCE", "TECHNICAL", "USER", "DRIVER", "VIEWER"] as const) {
      const { client } = await userAndClient([role]);
      expect((await client.get("/api/audit-logs")).status, role).toBe(403);
    }
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const res = await client.get("/api/audit-logs?action=AUTH_LOGIN&pageSize=5");
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: { action: string }) => r.action === "AUTH_LOGIN")).toBe(true);
    expect(res.body.meta.total).toBeGreaterThan(0);
    expect((await client.delete("/api/audit-logs")).status).toBe(404);
  });

  it("filters by user", async () => {
    const u = await createUser(["USER"]);
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const { login } = await import("./helpers.js");
    await login(u.email);
    const res = await client.get(`/api/audit-logs?userId=${u.id}`);
    expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(["AUTH_LOGIN"]);
  });
});
