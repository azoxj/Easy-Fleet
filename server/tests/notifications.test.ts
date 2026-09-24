import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { notifications } from "../src/db/schema/index.js";
import { isSafeInternalLink, notifyUsers } from "../src/services/notifications.js";
import { createProject, createUser, defaultOrgId, login } from "./helpers.js";

describe("notifications", () => {
  it("each user only sees and can mark their own notifications", async () => {
    const orgId = await defaultOrgId();
    const a = await createUser(["USER"]);
    const b = await createUser(["USER"]);
    await notifyUsers(db, { orgId, userIds: [a.id], type: "TEST", title: "لـ أ" });
    await notifyUsers(db, { orgId, userIds: [b.id], type: "TEST", title: "لـ ب" });
    const [bNote] = await db.select().from(notifications).where(eq(notifications.userId, b.id));

    const ac = await login(a.email);
    const list = await ac.get("/api/notifications");
    expect(list.body.data.map((n: { title: string }) => n.title)).toEqual(["لـ أ"]);
    expect((await ac.get("/api/notifications/unread-count")).body.data.count).toBe(1);

    // Cannot mark someone else's notification (IDOR) — 404, and it stays unread.
    expect((await ac.post(`/api/notifications/${bNote!.id}/read`)).status).toBe(404);
    const [still] = await db.select().from(notifications).where(eq(notifications.id, bNote!.id));
    expect(still!.readAt).toBeNull();

    // read-all only touches own rows
    expect((await ac.post("/api/notifications/read-all")).status).toBe(204);
    expect((await ac.get("/api/notifications/unread-count")).body.data.count).toBe(0);
    const [bAfter] = await db.select().from(notifications).where(eq(notifications.id, bNote!.id));
    expect(bAfter!.readAt).toBeNull();
  });

  it("marks a single own notification as read", async () => {
    const orgId = await defaultOrgId();
    const a = await createUser(["USER"]);
    await notifyUsers(db, { orgId, userIds: [a.id], type: "TEST", title: "x" });
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, a.id));
    const ac = await login(a.email);
    expect((await ac.post(`/api/notifications/${n!.id}/read`)).status).toBe(204);
    const unread = await ac.get("/api/notifications?unreadOnly=true");
    expect(unread.body.data).toHaveLength(0);
  });

  it("drops recipients who cannot see the notification's project (no cross-project leakage)", async () => {
    const orgId = await defaultOrgId();
    const member = await createUser(["USER"]);
    const outsider = await createUser(["USER"]);
    const finance = await createUser(["FINANCE"]); // projects.read ALL
    const p = await createProject({ members: [member.id] });
    const sent = await notifyUsers(db, { orgId, userIds: [member.id, outsider.id, finance.id], type: "TEST", title: "مشروع", projectId: p.id });
    expect(sent.sort()).toEqual([member.id, finance.id].sort());
    expect(await db.select().from(notifications).where(eq(notifications.userId, outsider.id))).toHaveLength(0);
  });

  it("never notifies disabled users or users of another organization", async () => {
    const orgId = await defaultOrgId();
    const disabled = await createUser(["USER"], { status: "DISABLED" });
    const sent = await notifyUsers(db, { orgId, userIds: [disabled.id], type: "TEST", title: "x" });
    expect(sent).toEqual([]);
    const sent2 = await notifyUsers(db, { orgId: "00000000-0000-4000-8000-000000000000", userIds: [(await createUser(["USER"])).id], type: "TEST", title: "x" });
    expect(sent2).toEqual([]);
  });

  it("accepts only in-app links", async () => {
    expect(isSafeInternalLink("/vehicles/123")).toBe(true);
    expect(isSafeInternalLink("//evil.example")).toBe(false);
    expect(isSafeInternalLink("https://evil.example")).toBe(false);
    expect(isSafeInternalLink("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalLink("/\\evil.example")).toBe(false);
    const orgId = await defaultOrgId();
    const u = await createUser(["USER"]);
    await expect(notifyUsers(db, { orgId, userIds: [u.id], type: "T", title: "x", link: "https://evil.example" })).rejects.toThrow();
  });
});
