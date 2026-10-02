import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { emailStatus, notificationCategory, smtpSecurity } from "./enums.js";
import { organizations } from "./organizations.js";

/**
 * Password reset tokens. Only the SHA-256 hash of the token is stored (the token
 * itself exists only in the email link), tokens are single-use and expire.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when the token is used, or invalidated by a newer request / a password change. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestedIp: text("requested_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_reset_tokens_user_idx").on(t.userId)],
);

/**
 * Outgoing email log + outbox. Notification emails are queued in the same
 * transaction as the business change and sent afterwards; security emails
 * (password reset) are sent directly and only logged — their body holds a
 * secret link and is never stored. No secret is ever written here.
 */
export const emailLog = pgTable(
  "email_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    recipient: text("recipient").notNull(),
    /** PASSWORD_RESET, PASSWORD_CHANGED, LOGIN_ALERT, TEST, or a notification type (e.g. INSURANCE_EXPIRING). */
    type: text("type").notNull(),
    category: notificationCategory("category"),
    subject: text("subject").notNull(),
    status: emailStatus("status").notNull().default("QUEUED"),
    /** Non-secret data to render a queued notification email (title, body, in-app link). */
    payload: jsonb("payload").$type<{ title: string; body?: string | null; link?: string | null }>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Safe, short reason (never the SMTP transcript or credentials). */
    failureReason: text("failure_reason"),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("email_log_org_created_idx").on(t.organizationId, t.createdAt),
    index("email_log_queue_idx").on(t.status, t.nextAttemptAt),
  ],
);

/**
 * Per-organization email (SMTP) settings managed from the admin page. Any field
 * left empty falls back to the environment (SMTP_HOST, SMTP_USER, …). The SMTP
 * password is stored encrypted (AES-256-GCM, key from EMAIL_SETTINGS_KEY) and is
 * never returned by the API.
 */
export const emailSettings = pgTable(
  "email_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpUser: text("smtp_user"),
    smtpPasswordEnc: text("smtp_password_enc"),
    smtpSecurity: smtpSecurity("smtp_security"),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    supportEmail: text("support_email"),
    /** Master switch for non-security notification emails of this organization. */
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    /** Categories the organization sends by email: { MAINTENANCE: true, FINANCE: false, … }. */
    categories: jsonb("categories").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("email_settings_port_ck", sql`${t.smtpPort} is null or (${t.smtpPort} between 1 and 65535)`)],
);
