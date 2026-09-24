import { eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { getDummyHash, hashPassword, passwordPolicyError, verifyPassword } from "../../auth/password.js";
import {
  clearSessionCookie,
  createSession,
  revokeAllUserSessions,
  revokeSession,
  setSessionCookie,
} from "../../auth/session.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { clientInfo, ctx } from "../../http/context.js";
import { badRequest, HttpError, unauthorized } from "../../http/errors.js";
import { rateLimit, requireAuth } from "../../http/middleware.js";
import { RateLimiter } from "../../lib/rate-limit.js";
import { audit } from "../../services/audit.js";

/** Per-IP cap on login attempts, and per-account cap on *failed* attempts. */
export const loginIpLimiter = new RateLimiter(30, 15 * 60_000);
export const loginFailLimiter = new RateLimiter(5, 15 * 60_000);

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const authRouter = Router();

authRouter.post("/login", rateLimit(loginIpLimiter), async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) throw unauthorized("البريد الإلكتروني أو كلمة المرور غير صحيحة");
  const { email, password } = body.data;

  const wait = loginFailLimiter.blocked(email);
  if (wait > 0) {
    res.setHeader("Retry-After", Math.ceil(wait / 1000).toString());
    throw new HttpError(429, "RATE_LIMITED", "تم تجاوز عدد المحاولات، حاول بعد قليل");
  }

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // Always run the hash, even for unknown emails, to avoid a timing oracle.
  const result = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !result.ok || user.status !== "ACTIVE") {
    loginFailLimiter.hit(email);
    await audit(db, req, {
      action: "AUTH_LOGIN_FAILED",
      entity: "user",
      entityId: user?.id ?? null,
      userId: user?.id ?? null,
      orgId: user?.organizationId ?? null,
      metadata: { reason: !user ? "unknown_email" : user.status !== "ACTIVE" ? "disabled" : "bad_password" },
    });
    throw unauthorized("البريد الإلكتروني أو كلمة المرور غير صحيحة");
  }
  loginFailLimiter.reset(email);

  const { ip, userAgent } = clientInfo(req);
  const session = await db.transaction(async (tx) => {
    const s = await createSession(tx, user.id, ip, userAgent);
    await tx
      .update(users)
      .set({
        lastLoginAt: new Date(),
        ...(result.needsRehash ? { passwordHash: await hashPassword(password) } : {}),
      })
      .where(eq(users.id, user.id));
    await audit(tx, req, {
      action: "AUTH_LOGIN",
      entity: "session",
      entityId: s.sessionId,
      userId: user.id,
      orgId: user.organizationId,
    });
    return s;
  });

  setSessionCookie(res, session.token);
  res.json({ data: { csrfToken: session.csrfToken, mustChangePassword: user.mustChangePassword } });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  const { user } = ctx(req);
  await revokeSession(db, user.sessionId);
  await audit(db, req, { action: "AUTH_LOGOUT", entity: "session", entityId: user.sessionId });
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  const { user, access } = ctx(req);
  res.json({
    data: {
      id: user.userId,
      email: user.email,
      name: user.name,
      mustChangePassword: user.mustChangePassword,
      roles: access.roleKeys,
      permissions: access.permissionMap(),
      projectIds: access.memberProjectIds,
      csrfToken: user.csrfToken,
    },
  });
});

authRouter.post("/change-password", requireAuth, rateLimit(new RateLimiter(10, 15 * 60_000), (r) => r.session!.userId), async (req, res) => {
  const { user } = ctx(req);
  const { currentPassword, newPassword } = ChangePasswordBody.parse(req.body);
  const policy = passwordPolicyError(newPassword);
  if (policy) throw badRequest(policy);
  if (newPassword === currentPassword) throw badRequest("كلمة المرور الجديدة يجب أن تختلف عن الحالية");

  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.userId));
  const ok = row && (await verifyPassword(currentPassword, row.passwordHash)).ok;
  if (!ok) throw badRequest("كلمة المرور الحالية غير صحيحة");

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.userId));
    // Sign out every other device.
    await revokeAllUserSessions(tx, user.userId, user.sessionId);
    await audit(tx, req, { action: "AUTH_PASSWORD_CHANGED", entity: "user", entityId: user.userId });
  });
  res.status(204).end();
});
