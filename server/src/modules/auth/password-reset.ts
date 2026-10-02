import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { type Request, Router } from "express";
import { z } from "zod";
import { hashPassword, passwordPolicyError, verifyPassword } from "../../auth/password.js";
import { hashToken, revokeAllUserSessions } from "../../auth/session.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { passwordResetTokens, users } from "../../db/schema/index.js";
import { sendPasswordChangedEmail, sendPasswordResetEmail } from "../../email/service.js";
import { badRequest } from "../../http/errors.js";
import { PgRateLimiter, pgRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { tr } from "../../i18n/index.js";
import { loginFailLimiter } from "./routes.js";

/**
 * Self-service password reset ("نسيت كلمة المرور؟").
 *
 * - The request endpoint answers the same generic message whatever the email,
 *   immediately, and does the work afterwards (no timing or content oracle).
 * - Tokens: 32 random bytes (base64url), only their SHA-256 is stored, single
 *   use, expire after PASSWORD_RESET_TTL_MINUTES; a new request invalidates the
 *   previous ones; a password change invalidates all of them.
 * - The link carries the token in the URL fragment (#token=…), which browsers
 *   never send to the server or in Referer headers, so it stays out of logs.
 * - A successful reset signs out every session and clears the login lock.
 * - Tokens and passwords are never logged or audited.
 */
export const passwordResetRouter = Router();

export const resetRequestIpLimiter = new PgRateLimiter("pwreset-ip", 10, 15 * 60_000);
export const resetRequestEmailLimiter = new PgRateLimiter("pwreset-email", 3, 60 * 60_000);
export const resetCompleteLimiter = new PgRateLimiter("pwreset-complete", 20, 15 * 60_000);

const auditRateLimited = (req: Request) => audit(db, req, { action: "SECURITY_RATE_LIMITED", entity: "auth", metadata: { path: req.originalUrl.split("?")[0] } });

const GENERIC = () => tr("إذا كان البريد مرتبطًا بحساب، فسيتم إرسال رابط إعادة تعيين كلمة المرور.");
const INVALID_LINK = () => tr("رابط إعادة التعيين غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.");

const ForgotBody = z.object({ email: z.string().trim().toLowerCase().max(254) });
const TokenField = z.string().trim().regex(/^[A-Za-z0-9_-]{32,128}$/);

export const resetLink = (token: string) => `${config.publicAppUrl}/reset-password#token=${token}`;

passwordResetRouter.post("/forgot-password", pgRateLimit(resetRequestIpLimiter, (r) => r.ip ?? "unknown", auditRateLimited), async (req, res) => {
  const parsed = ForgotBody.safeParse(req.body);
  res.json({ data: { message: GENERIC() } });
  if (!parsed.success || !z.email().safeParse(parsed.data.email).success) return;
  // Everything below runs after the response: the answer and its timing never depend on the account.
  void requestReset(req, parsed.data.email).catch((e: unknown) => console.error(`[password-reset] request failed: ${(e as Error)?.name ?? "error"}`));
});

export async function requestReset(req: Request, email: string): Promise<void> {
  // Per-email cap: silently ignored beyond it (same response), so the inbox cannot be flooded.
  if ((await resetRequestEmailLimiter.hit(email)) > 0) {
    await auditRateLimited(req);
    return;
  }
  const [user] = await db
    .select({ id: users.id, orgId: users.organizationId, email: users.email, name: users.name, status: users.status })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (!user || user.status !== "ACTIVE") {
    // recorded without the address typed (it may not belong to anyone)
    await audit(db, req, { action: "AUTH_PASSWORD_RESET_REQUESTED", entity: "user", orgId: user?.orgId ?? null, userId: user?.id ?? null, entityId: user?.id ?? null, metadata: { result: user ? "inactive_account" : "no_account" } });
    return;
  }
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    // only the newest link works
    await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000), requestedIp: req.ip ?? null });
    await audit(tx, req, { action: "AUTH_PASSWORD_RESET_REQUESTED", entity: "user", entityId: user.id, userId: user.id, orgId: user.orgId, metadata: { result: "link_sent", expiresInMinutes: config.PASSWORD_RESET_TTL_MINUTES } });
  });
  await sendPasswordResetEmail({ id: user.id, orgId: user.orgId, email: user.email, name: user.name }, resetLink(token));
}

/** A usable token row (unused, not expired, active user), or null. */
async function findUsableToken(token: string) {
  const [row] = await db
    .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId })
    .from(passwordResetTokens)
    .innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(and(eq(passwordResetTokens.tokenHash, hashToken(token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date()), eq(users.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

/** Lets the reset page tell "link expired" before the user types a new password. Reveals nothing about any account. */
passwordResetRouter.post("/reset-password/verify", pgRateLimit(resetCompleteLimiter, (r) => r.ip ?? "unknown", auditRateLimited), async (req, res) => {
  const t = TokenField.safeParse(req.body?.token);
  res.json({ data: { valid: t.success ? !!(await findUsableToken(t.data)) : false } });
});

const ResetBody = z.object({ token: TokenField, password: z.string().min(1).max(256) }).strict();

passwordResetRouter.post("/reset-password", pgRateLimit(resetCompleteLimiter, (r) => r.ip ?? "unknown", auditRateLimited), async (req, res) => {
  const parsed = ResetBody.safeParse(req.body);
  if (!parsed.success) throw badRequest(INVALID_LINK());
  const { token, password } = parsed.data;
  const policy = passwordPolicyError(password);
  if (policy) throw badRequest(policy);

  const done = await db.transaction(async (tx) => {
    // lock the token row: two concurrent submissions cannot both use it
    const [row] = await tx
      .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId, usedAt: passwordResetTokens.usedAt, expiresAt: passwordResetTokens.expiresAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashToken(token)))
      .for("update");
    if (!row || row.usedAt || row.expiresAt <= new Date()) return null;
    const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
    if (!user || user.status !== "ACTIVE") return null;
    if ((await verifyPassword(password, user.passwordHash)).ok) return "same" as const;
    await tx.update(users).set({ passwordHash: await hashPassword(password), mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
    // this token and any other outstanding one for the account
    await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
    // whoever had a session (maybe the attacker the user is locking out) is signed out
    await revokeAllUserSessions(tx, user.id);
    await audit(tx, req, { action: "AUTH_PASSWORD_RESET_COMPLETED", entity: "user", entityId: user.id, userId: user.id, orgId: user.organizationId });
    return user;
  });
  if (done === null) throw badRequest(INVALID_LINK());
  if (done === "same") throw badRequest(tr("كلمة المرور الجديدة يجب أن تختلف عن الحالية"));
  await loginFailLimiter.reset(done.email.toLowerCase());
  void sendPasswordChangedEmail({ id: done.id, orgId: done.organizationId, email: done.email, name: done.name });
  res.json({ data: { ok: true } });
});
