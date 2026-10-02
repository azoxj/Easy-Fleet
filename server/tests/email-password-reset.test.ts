import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { auditLogs, emailLog, emailSettings, notificationPreferences, organizations, passwordResetTokens, users, vehicles } from "../src/db/schema/index.js";
import { emailKindOf, processEmailQueue, setMailTransport, type OutgoingMail } from "../src/email/service.js";
import { esc, passwordResetEmail } from "../src/email/templates.js";
import { requestReset } from "../src/modules/auth/password-reset.js";
import { runServiceDueScan } from "../src/services/jobs.js";
import { notifyUsers } from "../src/services/notifications.js";
import { app, createProject, createUser, createVehicle, defaultOrgId, login, PASSWORD, userAndClient } from "./helpers.js";

// ---------------------------------------------------------------- capture transport (test-only hook; refused in production)
const sent: OutgoingMail[] = [];
let failWith: unknown = null;
const SMTP_SECRET = "smtp-Secret-Value-123";
const ORIGIN = "http://localhost:5173";

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
};
const post = (path: string, body: object, headers: Record<string, string> = {}) => request(app).post(path).set("origin", ORIGIN).set(headers).send(body);
const tokenFrom = (mail: OutgoingMail) => /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

let orgId: string;
const logs: string[] = [];
const spies: ReturnType<typeof vi.spyOn>[] = [];

beforeAll(async () => {
  orgId = await defaultOrgId();
  setMailTransport({
    async send(_cfg, mail) {
      if (failWith) throw failWith;
      sent.push(mail);
      return { messageId: `<${sent.length}@test>` };
    },
  });
  // email "configured" for the default organization (removed afterwards; later test files see no email config)
  await db.insert(emailSettings).values({ organizationId: orgId, smtpHost: "smtp.example.test", smtpPort: 587, smtpSecurity: "STARTTLS", fromEmail: "fleet@example.test", fromName: "Easy Fleet" }).onConflictDoNothing();
  for (const m of ["log", "warn", "error", "info"] as const) spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
});

afterAll(async () => {
  for (const s of spies) s.mockRestore();
  setMailTransport(null);
  await db.delete(emailSettings).where(eq(emailSettings.organizationId, orgId));
});

beforeEach(() => {
  sent.length = 0;
  failWith = null;
});
afterEach(() => {
  failWith = null;
});

async function requestAndWait(email: string, ip = "10.0.0.1") {
  const before = sent.length;
  const res = await post("/api/auth/forgot-password", { email }, { "X-Forwarded-For": ip });
  await waitFor(() => sent.length > before);
  return { res, mail: sent.at(-1)! };
}

// ================================================================= password reset
describe("forgot password: request", () => {
  it("1/12. existing and unknown emails get the same answer; only the existing one gets a link", async () => {
    const u = await createUser(["VIEWER"]);
    const a = await post("/api/auth/forgot-password", { email: u.email.toUpperCase() });
    const b = await post("/api/auth/forgot-password", { email: "nobody-here@example.test" });
    const c = await post("/api/auth/forgot-password", { email: "not-an-email" });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ data: { message: "إذا كان البريد مرتبطًا بحساب، فسيتم إرسال رابط إعادة تعيين كلمة المرور." } });
    }
    expect(Object.keys(a.headers).sort()).toEqual(Object.keys(b.headers).sort());
    await waitFor(() => sent.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(1); // nothing for the unknown / invalid address
    const mail = sent[0]!;
    expect(mail.to).toBe(u.email);
    expect(mail.subject).toBe("إعادة تعيين كلمة المرور - Easy Fleet");
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain("ينتهي هذا الرابط خلال");
    expect(mail.text).not.toContain(PASSWORD);
    const token = tokenFrom(mail);
    expect(mail.text).toContain(`${config.publicAppUrl}/reset-password#token=${token}`);
    // only the hash is stored
    const rows = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan((config.PASSWORD_RESET_TTL_MINUTES - 1) * 60_000);
    // audited for both, without the address that was typed
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "AUTH_PASSWORD_RESET_REQUESTED")).orderBy(desc(auditLogs.id)).limit(3);
    expect(audits.map((x) => x.metadata?.result).sort()).toEqual(expect.arrayContaining(["link_sent", "no_account"]));
    expect(JSON.stringify(audits)).not.toContain("nobody-here");
    expect(JSON.stringify(audits)).not.toContain(token);
    // the email log has no secret
    const [log] = await db.select().from(emailLog).where(and(eq(emailLog.userId, u.id), eq(emailLog.type, "PASSWORD_RESET")));
    expect(log).toMatchObject({ status: "SENT", recipient: u.email, payload: null });
    expect(JSON.stringify(log)).not.toContain(token);
  });

  it("2. a disabled account gets no link either (same answer)", async () => {
    const u = await createUser(["VIEWER"], { status: "DISABLED" });
    const r = await post("/api/auth/forgot-password", { email: u.email });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(sent).toHaveLength(0);
  });

  it("a new request invalidates the previous link", async () => {
    const u = await createUser(["VIEWER"]);
    const first = tokenFrom((await requestAndWait(u.email)).mail);
    const second = tokenFrom((await requestAndWait(u.email)).mail);
    expect(first).not.toBe(second);
    expect((await post("/api/auth/reset-password/verify", { token: first })).body.data.valid).toBe(false);
    expect((await post("/api/auth/reset-password/verify", { token: second })).body.data.valid).toBe(true);
  });

  it("9. rate limiting: 3 links per email per hour (silently), 10 requests per IP per 15 min (429)", async () => {
    const u = await createUser(["VIEWER"]);
    for (let i = 0; i < 4; i++) await post("/api/auth/forgot-password", { email: u.email }, { "X-Forwarded-For": "10.9.9.9" });
    await waitFor(() => sent.length >= 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(3); // the 4th got the same 200 answer but no email
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post("/api/auth/forgot-password", { email: `x${i}@example.test` })).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true); // 4 + 6 = 10 allowed from this IP
    expect(codes.at(-1)).toBe(429);
  });

  it("CSRF/origin: a cross-site form cannot trigger reset requests", async () => {
    const r = await request(app).post("/api/auth/forgot-password").set("origin", "https://evil.example").send({ email: "a@example.test" });
    expect(r.status).toBe(403);
  });
});

describe("forgot password: completing the reset", () => {
  it("6/7/8. resets the password, signs out every session, old password rejected, new one works", async () => {
    const { user, client } = await userAndClient(["VIEWER"]);
    expect((await client.get("/api/auth/me")).status).toBe(200);
    const token = tokenFrom((await requestAndWait(user.email)).mail);
    const before = sent.length;
    const r = await post("/api/auth/reset-password", { token, password: "Brand-New-Pass-42" });
    expect(r.status).toBe(200);
    expect((await client.get("/api/auth/me")).status).toBe(401); // existing session revoked
    expect((await post("/api/auth/login", { email: user.email, password: PASSWORD })).status).toBe(401);
    const ok = await post("/api/auth/login", { email: user.email, password: "Brand-New-Pass-42" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.mustChangePassword).toBe(false);
    // "password changed" security email, without the password
    await waitFor(() => sent.length > before);
    const changed = sent.at(-1)!;
    expect(changed.subject).toBe("تم تغيير كلمة المرور - Easy Fleet");
    expect(changed.text + changed.html).not.toContain("Brand-New-Pass-42");
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "AUTH_PASSWORD_RESET_COMPLETED"), eq(auditLogs.userId, user.id)));
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("5. a used link cannot be used again", async () => {
    const u = await createUser(["VIEWER"]);
    const token = tokenFrom((await requestAndWait(u.email)).mail);
    expect((await post("/api/auth/reset-password", { token, password: "First-Reset-Pass-1" })).status).toBe(200);
    const again = await post("/api/auth/reset-password", { token, password: "Second-Reset-Pass-2" });
    expect(again.status).toBe(400);
    expect(again.body.error.message).toBe("رابط إعادة التعيين غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.");
    expect((await post("/api/auth/login", { email: u.email, password: "First-Reset-Pass-1" })).status).toBe(200);
  });

  it("3. an expired link is refused", async () => {
    const u = await createUser(["VIEWER"]);
    const token = tokenFrom((await requestAndWait(u.email)).mail);
    await db.update(passwordResetTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passwordResetTokens.tokenHash, sha(token)));
    expect((await post("/api/auth/reset-password/verify", { token })).body.data.valid).toBe(false);
    expect((await post("/api/auth/reset-password", { token, password: "Too-Late-Pass-11" })).status).toBe(400);
    expect((await post("/api/auth/login", { email: u.email, password: PASSWORD })).status).toBe(200);
  });

  it("4. invalid / malformed tokens are refused with the same message", async () => {
    for (const token of ["A".repeat(43), "short", "../../etc", ""]) {
      const r = await post("/api/auth/reset-password", { token, password: "Whatever-Pass-12" });
      expect(r.status, token).toBe(400);
      expect(r.body.error.message).toBe("رابط إعادة التعيين غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.");
      expect((await post("/api/auth/reset-password/verify", { token })).body.data.valid).toBe(false);
    }
  });

  it("the new password must follow the policy and differ from the current one; a refused attempt keeps the link usable", async () => {
    const u = await createUser(["VIEWER"]);
    const token = tokenFrom((await requestAndWait(u.email)).mail);
    expect((await post("/api/auth/reset-password", { token, password: "short" })).status).toBe(400);
    const same = await post("/api/auth/reset-password", { token, password: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.error.message).toBe("كلمة المرور الجديدة يجب أن تختلف عن الحالية");
    expect((await post("/api/auth/reset-password/verify", { token })).body.data.valid).toBe(true);
    expect((await post("/api/auth/reset-password", { token, password: "Policy-Ok-Pass-77" })).status).toBe(200);
  });

  it("changing the password while signed in invalidates outstanding reset links", async () => {
    const { user, client } = await userAndClient(["VIEWER"]);
    const token = tokenFrom((await requestAndWait(user.email)).mail);
    expect((await client.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "Changed-Inside-9" })).status).toBe(204);
    expect((await post("/api/auth/reset-password/verify", { token })).body.data.valid).toBe(false);
  });

  it("an admin reset sends a security notice (no password) and invalidates links", async () => {
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const target = await createUser(["VIEWER"]);
    const token = tokenFrom((await requestAndWait(target.email)).mail);
    const before = sent.length;
    const r = await admin.post(`/api/users/${target.id}/reset-password`);
    expect(r.status).toBe(200);
    await waitFor(() => sent.length > before);
    const notice = sent.at(-1)!;
    expect(notice.to).toBe(target.email);
    expect(notice.text).toContain("أعاد مسؤول النظام تعيين كلمة المرور");
    expect(notice.text + notice.html).not.toContain(r.body.data.temporaryPassword);
    expect((await post("/api/auth/reset-password/verify", { token })).body.data.valid).toBe(false);
  });

  it("14. normal sign-in still works and a login lock is cleared by a successful reset", async () => {
    const u = await createUser(["VIEWER"]);
    for (let i = 0; i < 5; i++) await post("/api/auth/login", { email: u.email, password: "wrong-Password-1" });
    expect((await post("/api/auth/login", { email: u.email, password: PASSWORD })).status).toBe(429);
    const token = tokenFrom((await requestAndWait(u.email)).mail);
    expect((await post("/api/auth/reset-password", { token, password: "Unlocked-Pass-55" })).status).toBe(200);
    expect((await post("/api/auth/login", { email: u.email, password: "Unlocked-Pass-55" })).status).toBe(200);
  });
});

// ================================================================= delivery, failures, secrets
describe("email delivery", () => {
  it("10. test email is sent server-side with the configured provider and logged", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const r = await client.post("/api/settings/email/test", {});
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ to: user.email, subject: "رسالة اختبار - Easy Fleet" });
    const [log] = await db.select().from(emailLog).where(eq(emailLog.id, r.body.data.logId));
    expect(log).toMatchObject({ status: "SENT", type: "TEST" });
    expect(log!.sentAt).toBeTruthy();
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.action, "EMAIL_SENT"), eq(auditLogs.entityId, log!.id)))).length).toBe(1);
  });

  it("11. a provider failure is not exposed, is logged safely and does not break the app", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    failWith = Object.assign(new Error(`535 5.7.8 Authentication failed for user admin password=${SMTP_SECRET}`), { code: "EAUTH", responseCode: 535 });
    const r = await client.post("/api/settings/email/test", {});
    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("تعذر إرسال رسالة الاختبار: SMTP authentication failed");
    expect(JSON.stringify(r.body)).not.toContain(SMTP_SECRET);
    const [log] = await db.select().from(emailLog).where(eq(emailLog.type, "TEST")).orderBy(desc(emailLog.createdAt)).limit(1);
    expect(log).toMatchObject({ status: "FAILED", failureReason: "SMTP authentication failed" });
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.action, "EMAIL_FAILED"), eq(auditLogs.entityId, log!.id)))).length).toBe(1);
    // the user-facing reset flow is unaffected: same generic answer
    const u = await createUser(["VIEWER"]);
    const f = await post("/api/auth/forgot-password", { email: u.email });
    expect(f.status).toBe(200);
    await waitFor(async () => (await db.select().from(emailLog).where(and(eq(emailLog.userId, u.id), eq(emailLog.status, "FAILED")))).length === 1);
    expect(logs.join("\n")).not.toContain(SMTP_SECRET);
  });

  it("not configured → nothing pretends to be sent: FAILED (security) / SKIPPED (notifications)", async () => {
    await db.update(emailSettings).set({ smtpHost: null }).where(eq(emailSettings.organizationId, orgId));
    const saved = config.SMTP_HOST;
    (config as { SMTP_HOST?: string }).SMTP_HOST = undefined;
    try {
      const u = await createUser(["VIEWER"]);
      await requestReset({ ip: "10.1.1.1", get: () => undefined, session: undefined } as never, u.email);
      expect(sent).toHaveLength(0);
      const [log] = await db.select().from(emailLog).where(eq(emailLog.userId, u.id));
      expect(log).toMatchObject({ status: "FAILED", type: "PASSWORD_RESET" });
      expect(log!.failureReason).toContain("not configured");
      await notifyUsers(db, { orgId, userIds: [u.id], type: "INSURANCE_EXPIRING", title: "تأمين المركبة X تنتهي خلال 7 يوم", link: "/vehicles" });
      const rows = await db.select().from(emailLog).where(and(eq(emailLog.userId, u.id), eq(emailLog.type, "INSURANCE_EXPIRING")));
      expect(rows.map((r) => r.status)).toEqual(["SKIPPED"]);
    } finally {
      (config as { SMTP_HOST?: string }).SMTP_HOST = saved;
      await db.update(emailSettings).set({ smtpHost: "smtp.example.test" }).where(eq(emailSettings.organizationId, orgId));
    }
  });

  it("13. no reset token, password or SMTP secret appears in logs, the email log or the audit trail", async () => {
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const u = await createUser(["VIEWER"]);
    const token = tokenFrom((await requestAndWait(u.email)).mail);
    await post("/api/auth/reset-password", { token, password: "Secret-New-Pass-88" });
    (config as { EMAIL_SETTINGS_KEY?: string }).EMAIL_SETTINGS_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      expect((await admin.put("/api/settings/email", { smtpUser: "mailer", smtpPassword: SMTP_SECRET })).status).toBe(200);
      const view = await admin.get("/api/settings/email");
      expect(JSON.stringify(view.body)).not.toContain(SMTP_SECRET);
      expect(view.body.data.saved.passwordSaved).toBe(true);
      const [row] = await db.select().from(emailSettings).where(eq(emailSettings.organizationId, orgId));
      expect(row!.smtpPasswordEnc).toMatch(/^v1:/);
      expect(row!.smtpPasswordEnc).not.toContain(SMTP_SECRET);
      await admin.put("/api/settings/email", { smtpUser: "", smtpPassword: "" }); // back to no auth
    } finally {
      (config as { EMAIL_SETTINGS_KEY?: string }).EMAIL_SETTINGS_KEY = undefined;
    }
    const audit = JSON.stringify(await db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(200));
    const elog = JSON.stringify(await db.select().from(emailLog).orderBy(desc(emailLog.createdAt)).limit(200));
    for (const secret of [token, sha(token), "Secret-New-Pass-88", SMTP_SECRET]) {
      expect(audit, "audit").not.toContain(secret);
      expect(elog, "email_log").not.toContain(secret);
      expect(logs.join("\n"), "console").not.toContain(secret);
    }
  });

  it("an SMTP password cannot be saved without EMAIL_SETTINGS_KEY (environment is used instead)", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const r = await client.put("/api/settings/email", { smtpPassword: "x-y-z-secret" });
    expect(r.status).toBe(400);
    expect(r.body.data).toBeUndefined();
  });
});

// ================================================================= notifications by email
describe("notification emails (outbox)", () => {
  it("eligible notifications queue an email in the same transaction, sent by the queue; preferences are honoured", async () => {
    const a = await createUser(["VIEWER"]);
    const b = await createUser(["VIEWER"]);
    await db.insert(notificationPreferences).values({ userId: b.id, category: "DOCUMENT_EXPIRY", enabled: true, emailEnabled: false });
    await notifyUsers(db, { orgId, userIds: [a.id, b.id], type: "REGISTRATION_EXPIRING", title: "استمارة المركبة EF-1 تنتهي خلال 7 يوم", link: "/vehicles" });
    // in-app for both, email only for A
    const queued = await db.select().from(emailLog).where(eq(emailLog.type, "REGISTRATION_EXPIRING"));
    expect(queued.filter((q) => q.userId === b.id)).toHaveLength(0);
    expect(queued.find((q) => q.userId === a.id)).toMatchObject({ status: "QUEUED", category: "DOCUMENT_EXPIRY" });
    const r = await processEmailQueue(50);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const mail = sent.find((m) => m.to === a.email)!;
    expect(mail.subject).toBe("استمارة المركبة EF-1 تنتهي خلال 7 يوم - Easy Fleet");
    expect(mail.html).toContain(`${config.publicAppUrl}/vehicles`);
    expect((await db.select().from(emailLog).where(and(eq(emailLog.userId, a.id), eq(emailLog.type, "REGISTRATION_EXPIRING"))))[0]!.status).toBe("SENT");
  });

  it("security/system rules: SYSTEM alerts ignore user email opt-outs; non-email types and org switches send nothing", async () => {
    const u = await createUser(["VIEWER"]);
    await db.insert(notificationPreferences).values({ userId: u.id, category: "MAINTENANCE", enabled: true, emailEnabled: false });
    await notifyUsers(db, { orgId, userIds: [u.id], type: "SYSTEM_BROADCAST", title: "تنبيه مهم" });
    await notifyUsers(db, { orgId, userIds: [u.id], type: "ASSIGNMENT_CREATED", title: "مهمة جديدة" }); // not an email type
    await notifyUsers(db, { orgId, userIds: [u.id], type: "MAINTENANCE_DUE", title: "صيانة", category: "MAINTENANCE" }); // user opted out
    const types = (await db.select().from(emailLog).where(eq(emailLog.userId, u.id))).map((r) => r.type);
    expect(types).toEqual(["SYSTEM_BROADCAST"]);
    await db.update(emailSettings).set({ categories: { ACCIDENT: false } }).where(eq(emailSettings.organizationId, orgId));
    await notifyUsers(db, { orgId, userIds: [u.id], type: "ACCIDENT_REPORTED", title: "حادث", category: "ACCIDENT" });
    await db.update(emailSettings).set({ categories: {} }).where(eq(emailSettings.organizationId, orgId));
    expect((await db.select().from(emailLog).where(and(eq(emailLog.userId, u.id), eq(emailLog.type, "ACCIDENT_REPORTED")))).length).toBe(0);
    expect(emailKindOf("ASSIGNMENT_CREATED")).toBeNull();
    expect(emailKindOf("INSURANCE_EXPIRED")?.tone).toBe("warning");
  });

  it("a failing provider is retried, then marked FAILED", async () => {
    const u = await createUser(["VIEWER"]);
    await notifyUsers(db, { orgId, userIds: [u.id], type: "ACCIDENT_REPORTED", title: "حادث جديد", category: "ACCIDENT" });
    failWith = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" });
    for (let i = 0; i < 3; i++) {
      await processEmailQueue(50);
      await db.update(emailLog).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(and(eq(emailLog.userId, u.id), eq(emailLog.status, "QUEUED")));
    }
    const [row] = await db.select().from(emailLog).where(eq(emailLog.userId, u.id));
    expect(row).toMatchObject({ status: "FAILED", attempts: 3, failureReason: "could not connect to the SMTP server" });
  });

  it("maintenance / oil change due reminders are created once per threshold and emailed", async () => {
    const { user: pm } = await userAndClient(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const v = await createVehicle(p.id, { currentOdometer: 9_700, nextOilChangeOdometer: 10_000 });
    const first = await runServiceDueScan();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const again = await runServiceDueScan();
    const mine = await db.select().from(emailLog).where(and(eq(emailLog.userId, pm.id), eq(emailLog.type, "OIL_CHANGE_DUE")));
    expect(mine).toHaveLength(1); // de-duplicated on the second run
    expect(again.notified).toBe(0);
    expect(mine[0]!.subject).toContain(v.plateNumber);
    await db.update(vehicles).set({ nextOilChangeOdometer: null }).where(eq(vehicles.id, v.id));
  });
});

// ================================================================= login alert, welcome
describe("account security emails", () => {
  it("new-device sign-in alert (not on the first sign-in, not for a known device)", async () => {
    const u = await createUser(["VIEWER"]);
    const ua = { "User-Agent": "Device-A" };
    await post("/api/auth/login", { email: u.email, password: PASSWORD }, ua);
    await post("/api/auth/login", { email: u.email, password: PASSWORD }, ua);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.filter((m) => m.to === u.email)).toHaveLength(0);
    await post("/api/auth/login", { email: u.email, password: PASSWORD }, { "User-Agent": "Device-B" });
    await waitFor(() => sent.some((m) => m.to === u.email));
    const alert = sent.find((m) => m.to === u.email)!;
    expect(alert.subject).toBe("تسجيل دخول جديد إلى حسابك - Easy Fleet");
    expect(alert.text).toContain("Device-B");
  });

  it("welcome email on account creation contains no password", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const email = `welcome-${Date.now()}@example.test`;
    const r = await client.post("/api/users", { name: "موظف جديد", email, roleKeys: ["VIEWER"] });
    expect(r.status).toBe(201);
    await waitFor(() => sent.some((m) => m.to === email));
    const w = sent.find((m) => m.to === email)!;
    expect(w.subject).toBe("مرحبًا بك في Easy Fleet");
    expect(w.text + w.html).not.toContain(r.body.temporaryPassword);
  });

  it("templates escape user-controlled text", () => {
    const m = passwordResetEmail({ appUrl: "https://fleet.example.com", supportEmail: null }, { name: '<img src=x onerror="x">', link: "https://fleet.example.com/reset-password#token=abc", minutes: 30 });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain(esc('<img src=x onerror="x">'));
  });
});

// ================================================================= admin page, tenant isolation
describe("email settings: access and tenant isolation", () => {
  it("only settings administrators of the organization; another organization sees nothing", async () => {
    const { client: viewer } = await userAndClient(["VIEWER"]);
    expect((await viewer.get("/api/settings/email")).status).toBe(403);
    expect((await viewer.post("/api/settings/email/test", {})).status).toBe(403);
    expect((await viewer.get("/api/settings/email/log")).status).toBe(403);
    const [other] = await db.insert(organizations).values({ name: "شركة أخرى", slug: `other-${Date.now()}` }).returning();
    const otherAdmin = await createUser(["SUPER_ADMIN"], { orgId: other!.id });
    const c = await login(otherAdmin.email);
    const log = await c.get("/api/settings/email/log?pageSize=100");
    expect(log.status).toBe(200);
    expect(log.body.data).toEqual([]); // the default organization's deliveries are invisible
    const view = await c.get("/api/settings/email");
    expect(view.body.data.saved.smtpHost).toBeNull(); // not the default organization's settings
    const mine = await (await userAndClient(["SUPER_ADMIN"])).client.get("/api/settings/email/log?pageSize=5");
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data[0]).not.toHaveProperty("payload");
  });

  it("the transport cannot be replaced in production", () => {
    const env = config.NODE_ENV;
    (config as { NODE_ENV: string }).NODE_ENV = "production";
    try {
      expect(() => setMailTransport(null)).toThrow(/production/);
    } finally {
      (config as { NODE_ENV: string }).NODE_ENV = env;
    }
  });
});

// keep the default organization's user table tidy for later suites
afterAll(async () => {
  await db.execute(sql`delete from email_log where organization_id = ${orgId}`);
  void users;
});
