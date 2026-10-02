import { eq } from "drizzle-orm";
import { config } from "../config.js";
import type { DbOrTx } from "../db/client.js";
import { emailSettings, organizations } from "../db/schema/index.js";
import { decryptSecret } from "./secret.js";

export type SmtpSecurity = "TLS" | "STARTTLS" | "NONE";

/** Effective SMTP configuration of an organization (admin page values over environment). Contains the password: server-side only. */
export type EmailConfig = {
  configured: boolean;
  /** Why it is not usable, for the admin status panel (never contains secrets). */
  problem: string | null;
  host: string | null;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  password: string | null;
  fromEmail: string | null;
  fromName: string;
  supportEmail: string | null;
  notificationsEnabled: boolean;
  categories: Record<string, boolean>;
  source: { host: "settings" | "env" | "none"; password: "settings" | "env" | "none" };
};

export async function loadEmailConfig(db: DbOrTx, orgId: string | null): Promise<EmailConfig> {
  const [row] = orgId ? await db.select().from(emailSettings).where(eq(emailSettings.organizationId, orgId)) : [];
  const [org] = orgId ? await db.select({ email: organizations.email }).from(organizations).where(eq(organizations.id, orgId)) : [];
  const host = row?.smtpHost || config.SMTP_HOST || null;
  const port = row?.smtpPort ?? config.SMTP_PORT ?? 587;
  const security: SmtpSecurity = row?.smtpSecurity ?? config.SMTP_SECURE ?? (port === 465 ? "TLS" : "STARTTLS");
  const user = row?.smtpUser || config.SMTP_USER || null;
  const savedPassword = row?.smtpPasswordEnc ? decryptSecret(row.smtpPasswordEnc) : null;
  const password = savedPassword ?? config.SMTP_PASSWORD ?? null;
  const fromEmail = row?.fromEmail || config.EMAIL_FROM || null;
  let problem: string | null = null;
  if (!host) problem = "SMTP host is not set";
  else if (!fromEmail) problem = "sender address (From email) is not set";
  else if (user && !password) problem = row?.smtpPasswordEnc ? "the saved SMTP password cannot be decrypted (check EMAIL_SETTINGS_KEY)" : "SMTP password is not set";
  return {
    configured: problem === null,
    problem,
    host,
    port,
    security,
    user,
    password,
    fromEmail,
    fromName: row?.fromName || config.EMAIL_FROM_NAME || "Easy Fleet",
    supportEmail: row?.supportEmail || config.SUPPORT_EMAIL || org?.email || fromEmail,
    notificationsEnabled: row?.notificationsEnabled ?? true,
    categories: row?.categories ?? {},
    source: { host: row?.smtpHost ? "settings" : config.SMTP_HOST ? "env" : "none", password: savedPassword ? "settings" : config.SMTP_PASSWORD ? "env" : "none" },
  };
}

/** Admin view: everything except the password (only whether one is set and where it comes from). */
export function publicEmailConfig(c: EmailConfig) {
  const { password, ...rest } = c;
  return { ...rest, passwordSet: !!password };
}
