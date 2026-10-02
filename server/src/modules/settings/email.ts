import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { emailLog, emailSettings, notificationCategory } from "../../db/schema/index.js";
import { canStoreSecrets, encryptSecret } from "../../email/secret.js";
import { sendTestEmail } from "../../email/service.js";
import { loadEmailConfig, publicEmailConfig } from "../../email/settings.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { paged, pagination } from "../../http/validate.js";
import { PgRateLimiter, pgRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { tr } from "../../i18n/index.js";

/**
 * Settings → Email ("إعدادات البريد الإلكتروني"): SMTP configuration of the
 * organization, a server-side test email and the delivery log.
 * The SMTP password is write-only: it is never returned, only "set / not set".
 */
export const emailSettingsRouter = Router();

const adminOnly = (req: Parameters<typeof ctx>[0]) => {
  const { access } = ctx(req);
  if (access.require("settings.manage") !== "ALL") throw forbidden();
  return access;
};

const CATEGORIES = notificationCategory.enumValues.filter((c) => c !== "SYSTEM");
const empty = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional().or(z.literal("").transform(() => null));

const SettingsBody = z
  .object({
    smtpHost: empty(z.string().trim().max(253).regex(/^[A-Za-z0-9.-]+$/, "اسم الخادم غير صالح")),
    smtpPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
    smtpUser: empty(z.string().trim().max(254)),
    /** Write-only. Omitted = keep the saved one; "" or null = remove it. */
    smtpPassword: z.string().max(500).nullable().optional(),
    smtpSecurity: z.enum(["TLS", "STARTTLS", "NONE"]).nullable().optional(),
    fromName: empty(z.string().trim().max(100)),
    fromEmail: empty(z.email().max(254)),
    supportEmail: empty(z.email().max(254)),
    notificationsEnabled: z.boolean().optional(),
    categories: z.partialRecord(z.enum(CATEGORIES), z.boolean()).optional(),
  })
  .strict();

async function view(orgId: string) {
  const cfg = await loadEmailConfig(db, orgId);
  const [row] = await db.select().from(emailSettings).where(eq(emailSettings.organizationId, orgId));
  return {
    effective: publicEmailConfig(cfg),
    saved: {
      smtpHost: row?.smtpHost ?? null,
      smtpPort: row?.smtpPort ?? null,
      smtpUser: row?.smtpUser ?? null,
      smtpSecurity: row?.smtpSecurity ?? null,
      fromName: row?.fromName ?? null,
      fromEmail: row?.fromEmail ?? null,
      supportEmail: row?.supportEmail ?? null,
      passwordSaved: !!row?.smtpPasswordEnc,
      notificationsEnabled: row?.notificationsEnabled ?? true,
      categories: Object.fromEntries(CATEGORIES.map((c) => [c, row?.categories?.[c] ?? true])),
      updatedAt: row?.updatedAt ?? null,
    },
    canStorePassword: canStoreSecrets(),
  };
}

emailSettingsRouter.get("/settings/email", requirePermission("settings.manage"), async (req, res) => {
  const access = adminOnly(req);
  res.json({ data: await view(access.orgId) });
});

emailSettingsRouter.put("/settings/email", requirePermission("settings.manage"), async (req, res) => {
  const access = adminOnly(req);
  const b = SettingsBody.parse(req.body);
  const patch: Partial<typeof emailSettings.$inferInsert> = {};
  for (const k of ["smtpHost", "smtpPort", "smtpUser", "smtpSecurity", "fromName", "fromEmail", "supportEmail", "notificationsEnabled"] as const) {
    if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
  }
  let passwordChange: "set" | "removed" | null = null;
  if (b.smtpPassword !== undefined) {
    if (b.smtpPassword) {
      if (!canStoreSecrets()) throw badRequest(tr("لا يمكن حفظ كلمة مرور SMTP دون ضبط EMAIL_SETTINGS_KEY على الخادم؛ استخدم SMTP_PASSWORD في متغيرات البيئة"));
      patch.smtpPasswordEnc = encryptSecret(b.smtpPassword);
      passwordChange = "set";
    } else {
      patch.smtpPasswordEnc = null;
      passwordChange = "removed";
    }
  }
  const [before] = await db.select().from(emailSettings).where(eq(emailSettings.organizationId, access.orgId));
  if (b.categories) patch.categories = { ...(before?.categories ?? {}), ...b.categories };
  await db.transaction(async (tx) => {
    await tx
      .insert(emailSettings)
      .values({ organizationId: access.orgId, ...patch, updatedBy: access.userId, updatedAt: new Date() })
      .onConflictDoUpdate({ target: emailSettings.organizationId, set: { ...patch, updatedBy: access.userId, updatedAt: new Date() } });
    // which fields changed — values of the password are never recorded
    const changed = Object.keys(patch).filter((k) => k !== "smtpPasswordEnc");
    await audit(tx, req, { action: "EMAIL_SETTINGS_UPDATED", entity: "organization", entityId: access.orgId, metadata: { fields: changed, smtpPassword: passwordChange } });
  });
  res.json({ data: await view(access.orgId) });
});

const testLimiter = new PgRateLimiter("email-test", 5, 15 * 60_000);
const TestBody = z.object({ to: z.email().max(254).optional() }).strict();

/** Sends a test email from the server with the effective configuration. */
emailSettingsRouter.post("/settings/email/test", requirePermission("settings.manage"), pgRateLimit(testLimiter, (r) => r.session?.userId ?? "anon"), async (req, res) => {
  const access = adminOnly(req);
  const { user } = ctx(req);
  const { to } = TestBody.parse(req.body ?? {});
  const r = await sendTestEmail(access.orgId, to ?? user.email, user.name, user.userId);
  // only a short, safe reason is returned (never the SMTP server's transcript)
  if (!r.ok) throw new HttpError(502, "EMAIL_FAILED", r.reason === "not configured" ? tr("إعدادات البريد غير مكتملة") : tr("تعذر إرسال رسالة الاختبار: {0}", r.reason ?? ""));
  res.json({ data: { ok: true, logId: r.logId } });
});

const LogQuery = pagination.extend({ status: z.enum(["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"]).optional(), type: z.string().trim().max(60).optional() });

/** Delivery log of the organization (no message bodies are stored). */
emailSettingsRouter.get("/settings/email/log", requirePermission("settings.manage"), async (req, res) => {
  const access = adminOnly(req);
  const q = LogQuery.parse(req.query);
  const where: SQL[] = [eq(emailLog.organizationId, access.orgId)];
  if (q.status) where.push(eq(emailLog.status, q.status));
  if (q.type) where.push(eq(emailLog.type, q.type));
  const cond = and(...where);
  const [rows, [count], stats] = await Promise.all([
    db
      .select({ id: emailLog.id, recipient: emailLog.recipient, type: emailLog.type, category: emailLog.category, subject: emailLog.subject, status: emailLog.status, attempts: emailLog.attempts, failureReason: emailLog.failureReason, createdAt: emailLog.createdAt, sentAt: emailLog.sentAt })
      .from(emailLog)
      .where(cond)
      .orderBy(desc(emailLog.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(emailLog).where(cond),
    db
      .select({ status: emailLog.status, n: sql<number>`count(*)::int` })
      .from(emailLog)
      .where(and(eq(emailLog.organizationId, access.orgId), sql`${emailLog.createdAt} > now() - interval '7 days'`))
      .groupBy(emailLog.status),
  ]);
  res.json({ ...paged(rows, count?.n ?? 0, q.page, q.pageSize), summary: Object.fromEntries(stats.map((s) => [s.status, s.n])) });
});
