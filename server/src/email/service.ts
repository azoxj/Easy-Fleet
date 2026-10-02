import { and, eq, inArray, lt, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { db as rootDb, type DbOrTx } from "../db/client.js";
import { emailLog } from "../db/schema/index.js";
import { audit } from "../services/audit.js";
import { loadEmailConfig, type EmailConfig } from "./settings.js";
import * as T from "./templates.js";

/**
 * Server-side email delivery.
 *
 * - Security emails (password reset/changed, login alert, welcome, test) are sent
 *   immediately with sendEmailNow(); only a log row is stored (never the body —
 *   a reset email carries a secret link).
 * - Notification emails (expiry, maintenance due, accidents, approvals, …) are
 *   queued in email_log inside the caller's transaction (outbox) and sent by
 *   processEmailQueue() after commit, with retries.
 * - Nothing here throws to the caller: failures are logged with a safe reason,
 *   the row is marked FAILED and the request carries on.
 * - Logs never contain recipients' passwords, tokens, links or SMTP credentials.
 */

export type OutgoingMail = { to: string; subject: string; html: string; text: string };
export type MailTransport = { send(cfg: EmailConfig, mail: OutgoingMail): Promise<{ messageId?: string }> };
export type MailUser = { id: string; orgId: string; email: string; name: string };

const smtpTransport: MailTransport = {
  async send(cfg, mail) {
    const transporter = nodemailer.createTransport({
      host: cfg.host!,
      port: cfg.port,
      secure: cfg.security === "TLS",
      requireTLS: cfg.security === "STARTTLS",
      ignoreTLS: cfg.security === "NONE",
      auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2" },
      logger: false,
      debug: false,
    });
    try {
      const info = await transporter.sendMail({
        from: { name: cfg.fromName, address: cfg.fromEmail! },
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
      });
      return { messageId: info.messageId };
    } finally {
      transporter.close();
    }
  },
};

let transport: MailTransport = smtpTransport;

/** Test hook only: replaces the SMTP transport. Refused in production (no fake sending there). */
export function setMailTransport(t: MailTransport | null) {
  if (config.NODE_ENV === "production") throw new Error("the mail transport cannot be replaced in production");
  transport = t ?? smtpTransport;
}

/** Short, safe failure reason: an error class, never the SMTP transcript, addresses or credentials. */
export function safeReason(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; command?: string } | null;
  const code = e?.code ?? "";
  if (code === "EAUTH") return "SMTP authentication failed";
  if (["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET"].includes(code)) return "could not connect to the SMTP server";
  if (code === "ETLS") return "TLS negotiation with the SMTP server failed";
  if (code === "EENVELOPE") return "the recipient address was rejected";
  if (code === "EMESSAGE") return "the message was rejected by the SMTP server";
  if (typeof e?.responseCode === "number") return `SMTP server error ${e.responseCode}`;
  return "email delivery failed";
}

const brandFor = (cfg: EmailConfig): T.Brand => ({ appUrl: config.publicAppUrl, supportEmail: cfg.supportEmail });

async function auditEmail(db: DbOrTx, orgId: string | null, userId: string | null, ok: boolean, logId: string, type: string, reason?: string) {
  try {
    await audit(db, null, { action: ok ? "EMAIL_SENT" : "EMAIL_FAILED", entity: "email", entityId: logId, orgId, userId, metadata: { type, ...(reason ? { reason } : {}) } });
  } catch {
    // auditing must never break delivery bookkeeping
  }
}

/**
 * Sends one email now and records it. Returns whether it was accepted by the provider.
 * Never throws. Use for security/transactional emails.
 */
export async function sendEmailNow(input: { orgId: string | null; userId: string | null; to: string; type: string; rendered: T.Rendered; db?: DbOrTx }): Promise<{ ok: boolean; reason?: string; logId?: string }> {
  const db = input.db ?? rootDb;
  try {
    const cfg = await loadEmailConfig(db, input.orgId);
    const [row] = await db
      .insert(emailLog)
      .values({ organizationId: input.orgId, userId: input.userId, recipient: input.to, type: input.type, category: "SYSTEM", subject: input.rendered.subject, status: cfg.configured ? "SENDING" : "FAILED", attempts: 1, failureReason: cfg.configured ? null : `email is not configured: ${cfg.problem}` })
      .returning({ id: emailLog.id });
    const logId = row!.id;
    if (!cfg.configured) {
      console.warn(`[email] ${input.type} not sent (log ${logId}): email is not configured`);
      await auditEmail(db, input.orgId, input.userId, false, logId, input.type, "not configured");
      return { ok: false, reason: "not configured", logId };
    }
    try {
      const r = await transport.send(cfg, { to: input.to, ...input.rendered });
      await db.update(emailLog).set({ status: "SENT", sentAt: new Date(), providerMessageId: r.messageId?.slice(0, 200) ?? null }).where(eq(emailLog.id, logId));
      await auditEmail(db, input.orgId, input.userId, true, logId, input.type);
      return { ok: true, logId };
    } catch (err) {
      const reason = safeReason(err);
      await db.update(emailLog).set({ status: "FAILED", failureReason: reason }).where(eq(emailLog.id, logId));
      console.warn(`[email] ${input.type} failed (log ${logId}): ${reason}`);
      await auditEmail(db, input.orgId, input.userId, false, logId, input.type, reason);
      return { ok: false, reason, logId };
    }
  } catch (err) {
    console.error(`[email] ${input.type} could not be recorded: ${(err as Error)?.name ?? "error"}`);
    return { ok: false, reason: "internal error" };
  }
}

/** Fire-and-forget variant for request handlers: the response never waits for (or reveals) delivery. */
export function sendEmailInBackground(input: Parameters<typeof sendEmailNow>[0]) {
  void sendEmailNow(input);
}

// ------------------------------------------------------------------ notification emails (outbox)

/** Which notification types are also sent by email, with the label shown in the email. */
export function emailKindOf(type: string): { label: string; tone: "info" | "warning" } | null {
  if (/_(EXPIRING|EXPIRED)$/.test(type)) return { label: "تنبيه انتهاء", tone: "warning" };
  if (type === "MAINTENANCE_DUE") return { label: "صيانة دورية مستحقة", tone: "warning" };
  if (type === "OIL_CHANGE_DUE") return { label: "تغيير زيت مستحق", tone: "warning" };
  if (type === "ACCIDENT_REPORTED") return { label: "حادث جديد", tone: "warning" };
  if (type === "VIOLATION_RECORDED") return { label: "مخالفة جديدة", tone: "warning" };
  if (type === "MAINTENANCE_CRITICAL") return { label: "صيانة حرجة", tone: "warning" };
  if (["MAINTENANCE_QUOTE_REVIEW", "MAINTENANCE_ACTION_REQUIRED", "INVOICE_SUBMITTED", "EXPENSE_SUBMITTED", "APPROVAL_REQUIRED"].includes(type)) return { label: "بانتظار الاعتماد", tone: "info" };
  if (/^(MAINTENANCE|MAINTENANCE_QUOTE|INVOICE|EXPENSE)_APPROVED$/.test(type)) return { label: "تم الاعتماد", tone: "info" };
  if (/^(MAINTENANCE|MAINTENANCE_QUOTE|INVOICE|EXPENSE)_REJECTED$/.test(type)) return { label: "تم الرفض", tone: "warning" };
  if (type === "SYSTEM_BROADCAST") return { label: "تنبيه مهم من النظام", tone: "info" };
  return null;
}

export type QueueInput = {
  orgId: string;
  type: string;
  category: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Recipients that already passed the in-app checks (organization, project visibility, active). */
  recipients: { id: string; email: string; emailEnabled: boolean | null }[];
};

/**
 * Queues notification emails in the caller's transaction, honouring the
 * organization switches and each user's email preference (SYSTEM alerts cannot
 * be turned off by users). When email is not configured the rows are recorded
 * as SKIPPED so administrators can see what was not delivered.
 */
export async function queueNotificationEmails(db: DbOrTx, input: QueueInput): Promise<number> {
  if (!emailKindOf(input.type) || input.recipients.length === 0) return 0;
  const cfg = await loadEmailConfig(db, input.orgId);
  if (!cfg.notificationsEnabled || cfg.categories[input.category] === false) return 0;
  const to = input.recipients.filter((r) => r.email && (input.category === "SYSTEM" || r.emailEnabled !== false));
  if (!to.length) return 0;
  const subject = `${input.title} - Easy Fleet`.slice(0, 300);
  await db.insert(emailLog).values(
    to.map((r) => ({
      organizationId: input.orgId,
      userId: r.id,
      recipient: r.email,
      type: input.type,
      category: input.category as typeof emailLog.$inferInsert.category,
      subject,
      status: cfg.configured ? ("QUEUED" as const) : ("SKIPPED" as const),
      failureReason: cfg.configured ? null : `email is not configured: ${cfg.problem}`,
      payload: { title: input.title, body: input.body ?? null, link: input.link ?? null },
    })),
  );
  if (cfg.configured) kickEmailQueue();
  return to.length;
}

const MAX_ATTEMPTS = 3;

/** Sends queued notification emails (safe to run on several instances: rows are claimed with SKIP LOCKED). */
export async function processEmailQueue(limit = 25, db: DbOrTx = rootDb): Promise<{ sent: number; failed: number; retried: number }> {
  const out = { sent: 0, failed: 0, retried: 0 };
  // rows left in SENDING by a crashed instance go back to the queue
  await db.update(emailLog).set({ status: "QUEUED" }).where(and(eq(emailLog.status, "SENDING"), sql`${emailLog.payload} is not null`, lt(emailLog.nextAttemptAt, sql`now() - interval '10 minutes'`)));
  const claimed = await db.execute<{ id: string }>(sql`
    update email_log set status = 'SENDING', attempts = attempts + 1, next_attempt_at = now()
     where id in (select id from email_log where status = 'QUEUED' and next_attempt_at <= now() and payload is not null
                  order by created_at limit ${limit} for update skip locked)
     returning id`);
  const ids = claimed.rows.map((r) => r.id);
  if (!ids.length) return out;
  const rows = await db.select().from(emailLog).where(inArray(emailLog.id, ids));
  const cfgs = new Map<string, EmailConfig>();
  for (const row of rows) {
    const orgKey = row.organizationId ?? "";
    if (!cfgs.has(orgKey)) cfgs.set(orgKey, await loadEmailConfig(db, row.organizationId));
    const cfg = cfgs.get(orgKey)!;
    if (!cfg.configured) {
      await db.update(emailLog).set({ status: "SKIPPED", failureReason: `email is not configured: ${cfg.problem}` }).where(eq(emailLog.id, row.id));
      continue;
    }
    const kind = emailKindOf(row.type) ?? { label: "", tone: "info" as const };
    const rendered = T.notificationEmail(brandFor(cfg), { title: row.payload!.title, body: row.payload!.body, link: row.payload!.link, label: kind.label, tone: kind.tone });
    try {
      const r = await transport.send(cfg, { to: row.recipient, ...rendered });
      await db.update(emailLog).set({ status: "SENT", sentAt: new Date(), failureReason: null, providerMessageId: r.messageId?.slice(0, 200) ?? null }).where(eq(emailLog.id, row.id));
      await auditEmail(db, row.organizationId, row.userId, true, row.id, row.type);
      out.sent++;
    } catch (err) {
      const reason = safeReason(err);
      if (row.attempts < MAX_ATTEMPTS) {
        await db.update(emailLog).set({ status: "QUEUED", failureReason: reason, nextAttemptAt: sql`now() + make_interval(mins => ${5 * row.attempts})` }).where(eq(emailLog.id, row.id));
        out.retried++;
      } else {
        await db.update(emailLog).set({ status: "FAILED", failureReason: reason }).where(eq(emailLog.id, row.id));
        console.warn(`[email] ${row.type} failed after ${row.attempts} attempts (log ${row.id}): ${reason}`);
        await auditEmail(db, row.organizationId, row.userId, false, row.id, row.type, reason);
        out.failed++;
      }
    }
  }
  return out;
}

let kickTimer: NodeJS.Timeout | null = null;
let running = false;
/** Runs the queue shortly (after the caller's transaction has had time to commit). */
export function kickEmailQueue(delayMs = 1500) {
  if (config.NODE_ENV === "test" || config.EMAIL_QUEUE_INTERVAL_SECONDS === 0 || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void runQueueSafely();
  }, delayMs);
  kickTimer.unref?.();
}

async function runQueueSafely() {
  if (running) return;
  running = true;
  try {
    await processEmailQueue();
  } catch (err) {
    console.error(`[email] queue run failed: ${(err as Error)?.name ?? "error"}`);
  } finally {
    running = false;
  }
}

/** Starts the in-process sender (index.ts). */
export function startEmailDispatcher(): NodeJS.Timeout | null {
  if (config.NODE_ENV === "test" || config.EMAIL_QUEUE_INTERVAL_SECONDS === 0) return null;
  const t = setInterval(() => void runQueueSafely(), config.EMAIL_QUEUE_INTERVAL_SECONDS * 1000);
  t.unref?.();
  return t;
}

// ------------------------------------------------------------------ named emails

export async function sendPasswordResetEmail(user: MailUser, link: string, db?: DbOrTx) {
  const cfg = await loadEmailConfig(db ?? rootDb, user.orgId);
  return sendEmailNow({ db, orgId: user.orgId, userId: user.id, to: user.email, type: "PASSWORD_RESET", rendered: T.passwordResetEmail(brandFor(cfg), { name: user.name, link, minutes: config.PASSWORD_RESET_TTL_MINUTES }) });
}

export async function sendPasswordChangedEmail(user: MailUser, opts: { byAdmin?: boolean } = {}, db?: DbOrTx) {
  const cfg = await loadEmailConfig(db ?? rootDb, user.orgId);
  return sendEmailNow({ db, orgId: user.orgId, userId: user.id, to: user.email, type: "PASSWORD_CHANGED", rendered: T.passwordChangedEmail(brandFor(cfg), { name: user.name, when: new Date(), byAdmin: opts.byAdmin }) });
}

export async function sendLoginAlertEmail(user: MailUser, info: { ip: string | null; userAgent: string | null }, db?: DbOrTx) {
  const cfg = await loadEmailConfig(db ?? rootDb, user.orgId);
  return sendEmailNow({ db, orgId: user.orgId, userId: user.id, to: user.email, type: "LOGIN_ALERT", rendered: T.loginAlertEmail(brandFor(cfg), { name: user.name, when: new Date(), ip: info.ip, device: info.userAgent?.slice(0, 160) ?? null }) });
}

export async function sendWelcomeEmail(user: MailUser, db?: DbOrTx) {
  const cfg = await loadEmailConfig(db ?? rootDb, user.orgId);
  return sendEmailNow({ db, orgId: user.orgId, userId: user.id, to: user.email, type: "WELCOME", rendered: T.welcomeEmail(brandFor(cfg), { name: user.name, email: user.email }) });
}

export async function sendTestEmail(orgId: string, to: string, by: string, userId: string | null, db?: DbOrTx) {
  const cfg = await loadEmailConfig(db ?? rootDb, orgId);
  return sendEmailNow({ db, orgId, userId, to, type: "TEST", rendered: T.testEmail(brandFor(cfg), { by }) });
}

type FleetEmail = { orgId: string; users: { id: string; email: string; emailEnabled?: boolean | null }[]; title: string; body?: string | null; link?: string | null };
const fleet = (type: string, category: string) => (db: DbOrTx, e: FleetEmail) =>
  queueNotificationEmails(db, { orgId: e.orgId, type, category, title: e.title, body: e.body, link: e.link, recipients: e.users.map((u) => ({ id: u.id, email: u.email, emailEnabled: u.emailEnabled ?? null })) });

/** Direct helpers (the automatic flows go through notifyUsers, which queues the same emails). */
export const sendMaintenanceReminderEmail = fleet("MAINTENANCE_DUE", "MAINTENANCE");
export const sendInsuranceExpiryEmail = fleet("INSURANCE_EXPIRING", "DOCUMENT_EXPIRY");
export const sendRegistrationExpiryEmail = fleet("REGISTRATION_EXPIRING", "DOCUMENT_EXPIRY");
export const sendApprovalNotificationEmail = fleet("APPROVAL_REQUIRED", "MAINTENANCE");
