/**
 * DEMO SEED — for local testing only. Every record is clearly labelled
 * "تجريبي" / "DEMO" and uses the reserved example.com / example.test domains.
 * Refuses to run in production. Passwords are random unless DEMO_PASSWORD is set,
 * and are printed once to the console.
 */
import { randomBytes } from "node:crypto";
import { isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { hashPassword, passwordPolicyError } from "../auth/password.js";
import type { RoleKey } from "../auth/permissions.js";
import { db, pool } from "../db/client.js";
import { syncCatalog } from "../db/bootstrap.js";
import { assignments, projects, projectUsers, roles, userRoles, users, vehicles } from "../db/schema/index.js";

if (config.NODE_ENV === "production") {
  console.error("[seed-demo] refusing to seed demo data in production");
  process.exit(1);
}

const password = process.env.DEMO_PASSWORD ?? `Demo-${randomBytes(9).toString("base64url")}9a`;
const policy = passwordPolicyError(password);
if (policy) {
  console.error(`[seed-demo] DEMO_PASSWORD rejected: ${policy}`);
  process.exit(1);
}

const [already] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = 'demo.admin@example.com'`);
if (already) {
  console.log("[seed-demo] demo data already present — skipping");
  await pool.end();
  process.exit(0);
}

const passwordHash = await hashPassword(password);

await db.transaction(async (tx) => {
  const { org } = await syncCatalog(tx);
  const roleRows = await tx.select().from(roles).where(isNull(roles.organizationId));
  const roleId = (k: RoleKey) => roleRows.find((r) => r.key === k)!.id;

  const mk = async (email: string, name: string, role: RoleKey) => {
    const [u] = await tx.insert(users).values({ organizationId: org.id, email, name, passwordHash }).returning();
    await tx.insert(userRoles).values({ userId: u!.id, roleId: roleId(role) });
    return u!;
  };
  const admin = await mk("demo.admin@example.com", "مدير النظام (تجريبي)", "SUPER_ADMIN");
  const pm1 = await mk("demo.pm1@example.com", "مدير مشروع أ (تجريبي)", "PROJECT_MANAGER");
  const pm2 = await mk("demo.pm2@example.com", "مدير مشروع ب (تجريبي)", "PROJECT_MANAGER");
  const fin = await mk("demo.finance@example.com", "مسؤول المالية (تجريبي)", "FINANCE");
  const tech = await mk("demo.tech@example.com", "فني (تجريبي)", "TECHNICAL");
  const driver = await mk("demo.driver@example.com", "سائق (تجريبي)", "DRIVER");
  await mk("demo.viewer@example.com", "مشاهد (تجريبي)", "VIEWER");
  void fin;

  const [pA] = await tx
    .insert(projects)
    .values({ organizationId: org.id, name: "مشروع تجريبي أ", code: "DEMO-A", managerId: pm1.id, status: "ACTIVE", budget: "250000.00", createdBy: admin.id })
    .returning();
  const [pB] = await tx
    .insert(projects)
    .values({ organizationId: org.id, name: "مشروع تجريبي ب", code: "DEMO-B", managerId: pm2.id, status: "ACTIVE", budget: "180000.00", createdBy: admin.id })
    .returning();
  await tx.insert(projectUsers).values([
    { projectId: pA!.id, userId: pm1.id, addedBy: admin.id },
    { projectId: pA!.id, userId: tech.id, addedBy: admin.id },
    { projectId: pB!.id, userId: pm2.id, addedBy: admin.id },
  ]);

  const vehicleRows = await tx
    .insert(vehicles)
    .values([
      { organizationId: org.id, plateNumber: "DEMO-1001", make: "تجريبي", model: "سيدان", year: 2023, projectId: pA!.id, createdBy: admin.id },
      { organizationId: org.id, plateNumber: "DEMO-1002", make: "تجريبي", model: "بيك أب", year: 2022, projectId: pA!.id, createdBy: admin.id },
      { organizationId: org.id, plateNumber: "DEMO-2001", make: "تجريبي", model: "فان", year: 2024, projectId: pB!.id, createdBy: admin.id },
      { organizationId: org.id, plateNumber: "DEMO-9001", make: "تجريبي", model: "احتياطي", year: 2021, projectId: null, createdBy: admin.id },
    ])
    .returning();
  const first = vehicleRows[0]!;

  await tx.insert(assignments).values({
    organizationId: org.id,
    type: "VEHICLE",
    assignedTo: driver.id,
    assignedBy: pm1.id,
    projectId: first.projectId,
    vehicleId: first.id,
    referenceId: first.id,
    title: "استلام المركبة DEMO-1001 (تجريبي)",
    priority: "MEDIUM",
  });
  await tx.insert(assignments).values({
    organizationId: org.id,
    type: "TASK",
    assignedTo: tech.id,
    assignedBy: pm1.id,
    projectId: pA!.id,
    title: "فحص دوري للمركبات (تجريبي)",
    priority: "HIGH",
  });
});

console.log("\n[seed-demo] DEMO data created. Accounts (all share this password):");
console.log(`  password: ${password}`);
for (const e of ["demo.admin", "demo.pm1", "demo.pm2", "demo.finance", "demo.tech", "demo.driver", "demo.viewer"]) {
  console.log(`  - ${e}@example.com`);
}
console.log("\nDo NOT use these accounts outside local testing.\n");
await pool.end();
