import { and, eq, isNull, sql } from "drizzle-orm";
import { hashPassword, passwordPolicyError } from "../auth/password.js";
import { db, pool } from "../db/client.js";
import { syncCatalog } from "../db/bootstrap.js";
import { roles, userRoles, users } from "../db/schema/index.js";

/**
 * 1. Syncs organization / permissions / built-in roles (idempotent).
 * 2. If BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD are set and no such
 *    user exists, creates the first SUPER_ADMIN. Remove those env vars afterwards.
 */
const { org, roleCount } = await db.transaction((tx) => syncCatalog(tx));
console.log(`[bootstrap] organization "${org.name}" ready, ${roleCount} system roles synced`);

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "مدير النظام";

if (email && password) {
  const policy = passwordPolicyError(password);
  if (policy) {
    console.error(`[bootstrap] BOOTSTRAP_ADMIN_PASSWORD rejected: ${policy}`);
    process.exitCode = 1;
  } else {
    const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (existing) {
      console.log("[bootstrap] admin user already exists — nothing to do");
    } else {
      const [role] = await db.select().from(roles).where(and(eq(roles.key, "SUPER_ADMIN"), isNull(roles.organizationId)));
      await db.transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({ organizationId: org.id, email, name, passwordHash: await hashPassword(password), mustChangePassword: true })
          .returning();
        await tx.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
      });
      console.log(`[bootstrap] SUPER_ADMIN ${email} created (must change password at first login)`);
    }
  }
} else {
  console.log("[bootstrap] BOOTSTRAP_ADMIN_* not set — skipping admin creation");
}
await pool.end();
