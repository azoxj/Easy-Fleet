import { and, eq, isNull, sql } from "drizzle-orm";
import { generateTemporaryPassword, hashPassword, passwordPolicyError } from "../auth/password.js";
import { db, pool } from "../db/client.js";
import { syncCatalog } from "../db/bootstrap.js";
import { auditLogs, roles, sessions, userRoles, users } from "../db/schema/index.js";

/**
 * One-off recovery when an account's password is lost (run from the Render Shell):
 *
 *   ADMIN_EMAIL=you@example.com NEW_PASSWORD='…' npm run db:reset-admin-password
 *
 * - NEW_PASSWORD omitted → a random temporary password is generated and printed once.
 * - No account with that email (e.g. the first deploy's bootstrap was skipped because
 *   BOOTSTRAP_ADMIN_* was missing or the password was too weak) → it is created as SUPER_ADMIN.
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
    const { org } = await db.transaction((tx) => syncCatalog(tx));
    const [role] = await db.select().from(roles).where(and(eq(roles.key, "SUPER_ADMIN"), isNull(roles.organizationId)));
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({ organizationId: org.id, email, name: process.env.ADMIN_NAME?.trim() || "مدير النظام", passwordHash, mustChangePassword: true }).returning();
      await tx.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
      await tx.execute(sql`delete from rate_limits where key = ${`login-fail:${email}`}`);
      await tx.insert(auditLogs).values({ organizationId: org.id, userId: u!.id, action: "USER_CREATED", entity: "user", entityId: u!.id, metadata: { via: "reset-admin-password script", role: "SUPER_ADMIN" } });
    });
    console.log(`[reset-password] no account existed for ${email}: created it as SUPER_ADMIN; must change the password at first login`);
    if (!given) console.log(`[reset-password] temporary password: ${password}`);
  } else {
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, mustChangePassword: true, ...(process.env.ACTIVATE === "true" ? { status: "ACTIVE" as const } : {}) }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
      await tx.execute(sql`delete from rate_limits where key = ${`login-fail:${email}`}`);
      await tx.insert(auditLogs).values({ organizationId: user.organizationId, userId: user.id, action: "AUTH_PASSWORD_CHANGED", entity: "user", entityId: user.id, metadata: { via: "reset-admin-password script" } });
    });
    // A disabled account gets the same "wrong password" message at login, so say it here.
    console.log(`[reset-password] password reset for ${email}; must change it at next login`);
    if (user.status !== "ACTIVE" && process.env.ACTIVATE === "true") console.log(`[reset-password] account re-activated (was ${user.status})`);
    else if (user.status !== "ACTIVE") console.log(`[reset-password] WARNING: this account is ${user.status} and cannot log in until an admin re-activates it (or run with ACTIVATE=true)`);
    if (!given) console.log(`[reset-password] temporary password: ${password}`);
  }
}
await pool.end();
