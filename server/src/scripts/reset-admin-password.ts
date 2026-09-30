import { eq, sql } from "drizzle-orm";
import { generateTemporaryPassword, hashPassword, passwordPolicyError } from "../auth/password.js";
import { db, pool } from "../db/client.js";
import { auditLogs, sessions, users } from "../db/schema/index.js";

/**
 * One-off recovery when an account's password is lost (run from the Render Shell):
 *
 *   ADMIN_EMAIL=you@example.com NEW_PASSWORD='…' npm run db:reset-admin-password
 *
 * - NEW_PASSWORD omitted → a random temporary password is generated and printed once.
 * - The user must change it at the next login; all their sessions are signed out;
 *   the failed-login lock for that email is cleared; the action is audited.
 * - Needs direct database access (DATABASE_URL), i.e. whoever can run it already
 *   controls the server. Nothing is exposed over HTTP.
 */
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const given = process.env.NEW_PASSWORD;

if (!email) {
  console.error("[reset-password] set ADMIN_EMAIL (and optionally NEW_PASSWORD)");
  process.exitCode = 1;
} else {
  const password = given || generateTemporaryPassword();
  const policy = passwordPolicyError(password);
  const [user] = policy ? [] : await db.select({ id: users.id, organizationId: users.organizationId, status: users.status }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (policy) {
    console.error(`[reset-password] NEW_PASSWORD rejected: ${policy}`);
    process.exitCode = 1;
  } else if (!user) {
    console.error(`[reset-password] no user with email ${email}`);
    process.exitCode = 1;
  } else {
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, mustChangePassword: true }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
      await tx.execute(sql`delete from rate_limits where key = ${`login-fail:${email}`}`);
      await tx.insert(auditLogs).values({ organizationId: user.organizationId, userId: user.id, action: "AUTH_PASSWORD_CHANGED", entity: "user", entityId: user.id, metadata: { via: "reset-admin-password script" } });
    });
    console.log(`[reset-password] password reset for ${email}${user.status !== "ACTIVE" ? ` (note: account status is ${user.status})` : ""}; must change it at next login`);
    if (!given) console.log(`[reset-password] temporary password: ${password}`);
  }
}
await pool.end();
