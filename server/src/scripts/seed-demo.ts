/**
 * DEMO SEED — for local testing only. Every record is clearly labelled
 * "تجريبي" / "DEMO" and uses the reserved example.com / example.test domains.
 * Refuses to run in production. Passwords are random unless DEMO_PASSWORD is set,
 * and are printed once to the console.
 */
import { randomBytes } from "node:crypto";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { hashPassword, passwordPolicyError } from "../auth/password.js";
import type { RoleKey } from "../auth/permissions.js";
import { db, pool } from "../db/client.js";
import { syncCatalog } from "../db/bootstrap.js";
import {
  assignments,
  drivers,
  employees,
  insurancePolicies,
  projects,
  projectUsers,
  roles,
  userRoles,
  users,
  vehicleDocuments,
  vehicleDriverHistory,
  vehicles,
} from "../db/schema/index.js";
import { addDays, today } from "../lib/clock.js";

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

// Always bring roles/permissions up to date first (new sprints add permissions).
await db.transaction((tx) => syncCatalog(tx));

const [already] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = 'demo.admin@example.com'`);
const passwordHash = await hashPassword(password);

if (already) {
  console.log("[seed-demo] Sprint 1 demo data already present — skipping phase 1");
} else await db.transaction(async (tx) => {
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

// ---------------------------------------------------------------- phase 2 (Sprint 2): people & documents
const [phase2] = await db.select({ id: employees.id }).from(employees).where(eq(employees.employeeNumber, "DEMO-E001"));
if (phase2) {
  console.log("[seed-demo] Sprint 2 demo data already present — skipping phase 2");
} else {
  await db.transaction(async (tx) => {
    const [admin] = await tx.select().from(users).where(sql`lower(${users.email}) = 'demo.admin@example.com'`);
    const [driverUser] = await tx.select().from(users).where(sql`lower(${users.email}) = 'demo.driver@example.com'`);
    const projectRows = await tx.select().from(projects).where(inArray(projects.code, ["DEMO-A", "DEMO-B"]));
    const pA = projectRows.find((p) => p.code === "DEMO-A")!;
    const pB = projectRows.find((p) => p.code === "DEMO-B")!;
    const orgId = pA.organizationId;
    const t = today();

    // 5 demo employees — obviously fictitious names, no real national IDs.
    const emp = await tx
      .insert(employees)
      .values([
        { organizationId: orgId, employeeNumber: "DEMO-E001", fullName: "موظف تجريبي 1", jobTitle: "سائق", projectId: pA.id, hireDate: addDays(t, -400), createdBy: admin!.id },
        { organizationId: orgId, employeeNumber: "DEMO-E002", fullName: "موظف تجريبي 2", jobTitle: "سائق", projectId: pA.id, hireDate: addDays(t, -300), createdBy: admin!.id },
        { organizationId: orgId, employeeNumber: "DEMO-E003", fullName: "سائق (تجريبي)", jobTitle: "سائق", projectId: pA.id, hireDate: addDays(t, -200), userId: driverUser?.id ?? null, createdBy: admin!.id },
        { organizationId: orgId, employeeNumber: "DEMO-E004", fullName: "موظف تجريبي 4", jobTitle: "مشرف موقع", projectId: pB.id, hireDate: addDays(t, -150), createdBy: admin!.id },
        { organizationId: orgId, employeeNumber: "DEMO-E005", fullName: "موظف تجريبي 5", jobTitle: "فني", projectId: pB.id, status: "SUSPENDED", createdBy: admin!.id },
      ])
      .returning();

    // 3 drivers with ACTIVE / EXPIRING_SOON / EXPIRED licenses relative to today.
    const drv = await tx
      .insert(drivers)
      .values([
        { organizationId: orgId, employeeId: emp[0]!.id, licenseNumber: "DEMO-L001", licenseType: "PRIVATE", licenseIssueDate: addDays(t, -700), licenseExpiryDate: addDays(t, 400), createdBy: admin!.id },
        { organizationId: orgId, employeeId: emp[1]!.id, licenseNumber: "DEMO-L002", licenseType: "HEAVY", licenseIssueDate: addDays(t, -1000), licenseExpiryDate: addDays(t, -10), createdBy: admin!.id },
        { organizationId: orgId, employeeId: emp[2]!.id, licenseNumber: "DEMO-L003", licenseType: "PUBLIC", licenseIssueDate: addDays(t, -900), licenseExpiryDate: addDays(t, 20), createdBy: admin!.id },
      ])
      .returning();

    // Ensure 5 demo vehicles exist.
    const [extra] = await tx.select().from(vehicles).where(eq(vehicles.plateNumber, "DEMO-2002"));
    if (!extra) {
      await tx.insert(vehicles).values({ organizationId: orgId, plateNumber: "DEMO-2002", make: "تجريبي", model: "شاحنة", year: 2020, projectId: pB.id, createdBy: admin!.id });
    }
    const v = await tx.select().from(vehicles).where(inArray(vehicles.plateNumber, ["DEMO-1001", "DEMO-1002", "DEMO-2001", "DEMO-2002", "DEMO-9001"]));
    const byPlate = (p: string) => v.find((x) => x.plateNumber === p)!;

    // Current driver of DEMO-1001 = the demo driver account (license expiring soon).
    const v1001 = byPlate("DEMO-1001");
    await tx.update(vehicles).set({ assignedDriverId: drv[2]!.id, status: "ASSIGNED" }).where(eq(vehicles.id, v1001.id));
    await tx.insert(vehicleDriverHistory).values({ organizationId: orgId, vehicleId: v1001.id, driverId: drv[2]!.id, assignedBy: admin!.id });

    // Registrations & insurance with mixed statuses.
    const reg = (plate: string, n: string, expiryOffset: number) => ({
      organizationId: orgId,
      vehicleId: byPlate(plate).id,
      documentType: "REGISTRATION" as const,
      documentNumber: n,
      issueDate: addDays(t, expiryOffset - 365),
      expiryDate: addDays(t, expiryOffset),
      issuer: "جهة تجريبية",
      notes: "بيانات تجريبية",
      createdBy: admin!.id,
    });
    await tx.insert(vehicleDocuments).values([
      reg("DEMO-1001", "DEMO-R1001", 200), // ACTIVE
      reg("DEMO-1002", "DEMO-R1002", 12), // EXPIRING_SOON
      reg("DEMO-2001", "DEMO-R2001", -20), // EXPIRED
      reg("DEMO-2002", "DEMO-R2002", 90), // ACTIVE
    ]);
    const ins = (plate: string, n: string, expiryOffset: number, coverage: "THIRD_PARTY" | "COMPREHENSIVE") => ({
      organizationId: orgId,
      vehicleId: byPlate(plate).id,
      provider: "شركة تأمين تجريبية",
      policyNumber: n,
      issueDate: addDays(t, expiryOffset - 365),
      expiryDate: addDays(t, expiryOffset),
      premiumAmount: "1000.00",
      coverageType: coverage,
      notes: "بيانات تجريبية",
      createdBy: admin!.id,
    });
    await tx.insert(insurancePolicies).values([
      ins("DEMO-1001", "DEMO-P1001", 25, "COMPREHENSIVE"), // EXPIRING_SOON
      ins("DEMO-1002", "DEMO-P1002", 300, "THIRD_PARTY"), // ACTIVE
      ins("DEMO-2001", "DEMO-P2001", -5, "THIRD_PARTY"), // EXPIRED
      ins("DEMO-9001", "DEMO-P9001", 150, "COMPREHENSIVE"), // ACTIVE
    ]);
    await tx.insert(vehicleDocuments).values({
      organizationId: orgId,
      vehicleId: byPlate("DEMO-2002").id,
      documentType: "WARRANTY",
      documentNumber: "DEMO-W2002",
      issuer: "وكيل تجريبي",
      issueDate: addDays(t, -100),
      expiryDate: addDays(t, 265),
      createdBy: admin!.id,
    });
  });
  console.log("[seed-demo] Sprint 2 demo data created (5 employees, 3 drivers, registrations, insurance)");
}

console.log("\n[seed-demo] DEMO data created. Accounts (all share this password):");
console.log(`  password: ${password}`);
for (const e of ["demo.admin", "demo.pm1", "demo.pm2", "demo.finance", "demo.tech", "demo.driver", "demo.viewer"]) {
  console.log(`  - ${e}@example.com`);
}
console.log("\nDo NOT use these accounts outside local testing.\n");
await pool.end();
