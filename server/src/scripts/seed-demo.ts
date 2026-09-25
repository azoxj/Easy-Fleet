/**
 * DEMO SEED — every record is clearly labelled "تجريبي" / "DEMO" and uses the
 * reserved example.com domain. Idempotent: each phase has a marker row and is
 * skipped when it already exists; nothing is ever deleted or reset.
 *
 * Local/dev: runs as is. Passwords are random unless DEMO_PASSWORD is set; a
 * random password is printed once so you can log in.
 * Production (e.g. a Render preview): refuses unless ALLOW_DEMO_SEED=true AND
 * DEMO_PASSWORD is set. The password is then never printed.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { hashPassword, passwordPolicyError } from "../auth/password.js";
import type { RoleKey } from "../auth/permissions.js";
import { db, pool } from "../db/client.js";
import { syncCatalog } from "../db/bootstrap.js";
import { schemaStatus } from "../db/migrations.js";
import {
  accidents,
  employeeDocuments,
  expenses,
  files,
  fuelTransactions,
  handoverSessions,
  invoices,
  invoiceTransfers,
  locationPings,
  notifications,
  trips,
  vehicleLocations,
  violations,
  assignments,
  drivers,
  employees,
  insurancePolicies,
  maintenanceEvents,
  maintenanceLabor,
  maintenanceParts,
  maintenanceQuotes,
  maintenanceRequests,
  projects,
  projectUsers,
  roles,
  userRoles,
  users,
  vehicleDocuments,
  vehicleDriverHistory,
  vehicles,
  vendors,
} from "../db/schema/index.js";
import { addDays, today } from "../lib/clock.js";
import { haversineMeters } from "../modules/operations/tracking.js";
import { FULL_DEMO_MARKER_PROJECT, seedFullDemo, type FullDemoCounts } from "./seed-demo-full.js";

const production = config.NODE_ENV === "production";
// Used exactly as given (a blank value counts as unset).
const demoPassword = process.env.DEMO_PASSWORD?.trim() ? process.env.DEMO_PASSWORD : undefined;
if (production && (process.env.ALLOW_DEMO_SEED !== "true" || !demoPassword)) {
  console.error("[seed-demo] refusing to seed demo data in production: set ALLOW_DEMO_SEED=true and DEMO_PASSWORD (demo/preview databases only)");
  process.exit(1);
}

// Never seed an unmigrated database (npm run db:migrate first).
const schema = await schemaStatus(pool);
if (!schema.ok) {
  console.error(`[seed-demo] database is not migrated (missing tables: ${schema.missingTables.join(", ") || "-"}); run npm run db:migrate first`);
  await pool.end();
  process.exit(1);
}

const password = demoPassword ?? `Demo-${randomBytes(9).toString("base64url")}9a`;
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
    .values({ organizationId: org.id, name: "مشروع الرياض (تجريبي)", code: "DEMO-A", managerId: pm1.id, status: "ACTIVE", budget: "250000.00", createdBy: admin.id })
    .returning();
  const [pB] = await tx
    .insert(projects)
    .values({ organizationId: org.id, name: "مشروع جدة (تجريبي)", code: "DEMO-B", managerId: pm2.id, status: "ACTIVE", budget: "180000.00", createdBy: admin.id })
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

// ---------------------------------------------------------------- phase 3 (Sprint 2 / Part 2): maintenance
const [phase3] = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.name, "ورشة تجريبية (DEMO)"));
if (phase3) {
  console.log("[seed-demo] maintenance demo data already present — skipping phase 3");
} else {
  await db.transaction(async (tx) => {
    const byEmail = async (e: string) => (await tx.select().from(users).where(sql`lower(${users.email}) = ${e}`))[0]!;
    const pm1 = await byEmail("demo.pm1@example.com");
    const pm2 = await byEmail("demo.pm2@example.com");
    const tech = await byEmail("demo.tech@example.com");
    const projectRows = await tx.select().from(projects).where(inArray(projects.code, ["DEMO-A", "DEMO-B"]));
    const pB = projectRows.find((p) => p.code === "DEMO-B")!;
    const orgId = pB.organizationId;
    // demo technician also works on project B
    await tx.insert(projectUsers).values({ projectId: pB.id, userId: tech.id, addedBy: pm2.id }).onConflictDoNothing();
    const v = await tx.select().from(vehicles).where(inArray(vehicles.plateNumber, ["DEMO-1001", "DEMO-1002", "DEMO-2001", "DEMO-2002"]));
    const byPlate = (p: string) => v.find((x) => x.plateNumber === p)!;
    const [vendor] = await tx.insert(vendors).values({ organizationId: orgId, name: "ورشة تجريبية (DEMO)", phone: "+966500000000", notes: "مورد تجريبي — ليس جهة حقيقية" }).returning();
    const now = new Date();

    const mk = async (plate: string, requestedBy: string, extra: Partial<typeof maintenanceRequests.$inferInsert>, events: { type: string; from?: string; to: string; actor: string; reason?: string }[]) => {
      const veh = byPlate(plate);
      const [mr] = await tx
        .insert(maintenanceRequests)
        .values({ organizationId: orgId, vehicleId: veh.id, projectId: veh.projectId, requestedBy, priority: "MEDIUM", odometer: veh.currentOdometer, issue: "(DEMO)", ...extra })
        .returning();
      for (const e of events) {
        await tx.insert(maintenanceEvents).values({ organizationId: orgId, maintenanceRequestId: mr!.id, type: e.type, fromStatus: (e.from ?? null) as never, toStatus: e.to as never, actorId: e.actor, reason: e.reason ?? null, metadata: { demo: true } });
      }
      if (extra.assignedTo) {
        await tx.insert(assignments).values({ organizationId: orgId, type: "MAINTENANCE_REQUEST", assignedTo: extra.assignedTo, assignedBy: requestedBy, projectId: veh.projectId, vehicleId: veh.id, referenceId: mr!.id, title: `صيانة MR-${mr!.number}: ${mr!.issue}`.slice(0, 200) });
      }
      return mr!;
    };

    await mk("DEMO-1001", pm1.id, { issue: "(DEMO) صوت غير طبيعي عند التشغيل", priority: "MEDIUM", description: "بيانات تجريبية" }, [{ type: "CREATED", to: "REQUESTED", actor: pm1.id }]);
    await mk("DEMO-1001", pm1.id, { issue: "(DEMO) اهتزاز في المقود", priority: "HIGH", status: "INSPECTION", assignedTo: tech.id, assignedAt: now, inspectionStartedAt: now }, [
      { type: "CREATED", to: "REQUESTED", actor: pm1.id },
      { type: "INSPECTION_STARTED", from: "REQUESTED", to: "INSPECTION", actor: tech.id },
    ]);
    const repair = await mk(
      "DEMO-1002",
      pm1.id,
      { issue: "(DEMO) تغيير فحمات الفرامل", priority: "HIGH", status: "IN_REPAIR", assignedTo: tech.id, diagnosis: "(DEMO) تآكل الفحمات الأمامية", assignedAt: now, inspectionStartedAt: now, approvedAt: now, startedAt: now, vehicleStatusBefore: "AVAILABLE" },
      [
        { type: "CREATED", to: "REQUESTED", actor: pm1.id },
        { type: "INSPECTION_STARTED", from: "REQUESTED", to: "INSPECTION", actor: tech.id },
        { type: "INSPECTION_COMPLETED", from: "INSPECTION", to: "QUOTE_PENDING", actor: tech.id },
        { type: "APPROVED", from: "PENDING_APPROVAL", to: "APPROVED", actor: pm1.id },
        { type: "REPAIR_STARTED", from: "APPROVED", to: "IN_REPAIR", actor: tech.id },
      ],
    );
    await tx.update(vehicles).set({ status: "IN_MAINTENANCE" }).where(eq(vehicles.id, byPlate("DEMO-1002").id));
    await tx.insert(maintenanceQuotes).values({ organizationId: orgId, maintenanceRequestId: repair.id, vendorId: vendor!.id, quoteNumber: "DEMO-Q1", amount: "650.00", status: "APPROVED", createdBy: tech.id, submittedAt: now, reviewedAt: now, notes: "عرض تجريبي" });
    await tx.insert(maintenanceParts).values({ organizationId: orgId, maintenanceRequestId: repair.id, partName: "(DEMO) فحمات فرامل", partNumber: "DEMO-BP", quantity: "2", unitPrice: "180.00", total: sql`round(2::numeric * 180::numeric, 2)`, vendorId: vendor!.id });
    await tx.insert(maintenanceLabor).values({ organizationId: orgId, maintenanceRequestId: repair.id, description: "(DEMO) تركيب وفحص", hours: "2", hourlyRate: "120.00", total: sql`round(2::numeric * 120::numeric, 2)` });
    await mk(
      "DEMO-2001",
      pm2.id,
      { issue: "(DEMO) تسريب زيت", priority: "CRITICAL", status: "READY_FOR_HANDOVER", assignedTo: tech.id, diagnosis: "(DEMO) جوان غطاء المحرك", workPerformed: "(DEMO) تم تغيير الجوان", assignedAt: now, startedAt: now, readyAt: now },
      [
        { type: "CREATED", to: "REQUESTED", actor: pm2.id },
        { type: "REPAIR_STARTED", from: "APPROVED", to: "IN_REPAIR", actor: tech.id },
        { type: "READY_FOR_HANDOVER", from: "IN_REPAIR", to: "READY_FOR_HANDOVER", actor: tech.id },
      ],
    );
    await mk("DEMO-2002", pm2.id, { issue: "(DEMO) طلب تلميع الهيكل", priority: "LOW", status: "REJECTED", rejectionReason: "(DEMO) ليس من أعمال الصيانة" }, [
      { type: "CREATED", to: "REQUESTED", actor: pm2.id },
      { type: "REJECTED", from: "REQUESTED", to: "REJECTED", actor: pm2.id, reason: "(DEMO) ليس من أعمال الصيانة" },
    ]);
  });
  console.log("[seed-demo] maintenance demo data created (5 requests: REQUESTED, INSPECTION, IN_REPAIR, READY_FOR_HANDOVER, REJECTED)");
}

// ---------------------------------------------------------------- phase 4: finance, operations, handover, GPS
const [phase4] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.invoiceNumber, "DEMO-INV-001"));
let demoHandoverLink: string | null = null;
if (phase4) {
  console.log("[seed-demo] operations/finance demo data already present — skipping phase 4");
} else {
  await db.transaction(async (tx) => {
    const byEmail = async (e: string) => (await tx.select().from(users).where(sql`lower(${users.email}) = ${e}`))[0]!;
    const admin = await byEmail("demo.admin@example.com");
    const pm1 = await byEmail("demo.pm1@example.com");
    const pm2 = await byEmail("demo.pm2@example.com");
    const fin = await byEmail("demo.finance@example.com");
    const tech = await byEmail("demo.tech@example.com");
    const driverUser = await byEmail("demo.driver@example.com");
    const projectRows = await tx.select().from(projects).where(inArray(projects.code, ["DEMO-A", "DEMO-B"]));
    const pA = projectRows.find((p) => p.code === "DEMO-A")!;
    const pB = projectRows.find((p) => p.code === "DEMO-B")!;
    const orgId = pA.organizationId;
    const t = today();
    const at = (daysAgo: number, hour = 9) => new Date(`${addDays(t, -daysAgo)}T${String(hour).padStart(2, "0")}:00:00+03:00`);
    await tx.update(projects).set({ contractValue: "400000.00" }).where(eq(projects.id, pA.id));
    await tx.update(projects).set({ contractValue: "260000.00" }).where(eq(projects.id, pB.id));

    const v = await tx.select().from(vehicles).where(inArray(vehicles.plateNumber, ["DEMO-1001", "DEMO-1002", "DEMO-2001", "DEMO-2002", "DEMO-9001"]));
    const byPlate = (p: string) => v.find((x) => x.plateNumber === p)!;
    const arabic: Record<string, [string, string, string]> = { "DEMO-1001": ["د م و 1001", "DMO 1001", "900001001"], "DEMO-1002": ["د م و 1002", "DMO 1002", "900001002"], "DEMO-2001": ["د م و 2001", "DMO 2001", "900002001"], "DEMO-2002": ["د م و 2002", "DMO 2002", "900002002"], "DEMO-9001": ["د م و 9001", "DMO 9001", "900009001"] };
    for (const [plate, [ar, en, serial]] of Object.entries(arabic)) {
      await tx.update(vehicles).set({ plateArabic: ar, plateEnglish: en, serialNumber: serial, currentOdometer: sql`greatest(${vehicles.currentOdometer}, 25000)` }).where(eq(vehicles.id, byPlate(plate).id));
    }
    await tx.update(vendors).set({ taxNumber: "300000000000003", address: "عنوان تجريبي (DEMO)" }).where(eq(vendors.name, "ورشة تجريبية (DEMO)"));
    const [vendor] = await tx.select().from(vendors).where(eq(vendors.name, "ورشة تجريبية (DEMO)"));
    const [drv] = await tx.select({ id: drivers.id }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(employees.employeeNumber, "DEMO-E003"));

    // Demo PDF files (real bytes in private storage) for invoices/receipts.
    const demoFile = async (name: string, uploadedBy: string) => {
      const body = Buffer.from(`%PDF-1.4\n% DEMO file (${name}) — not a real document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
      const key = `${orgId}/${randomUUID()}`;
      const full = path.join(path.resolve(config.STORAGE_DIR), key);
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await writeFile(full, body, { mode: 0o600, flag: "wx" });
      const [f] = await tx.insert(files).values({ organizationId: orgId, storageKey: key, originalName: name, mimeType: "application/pdf", sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), uploadedBy }).returning();
      return f!.id;
    };

    // Fuel: 6 months of fill-ups with increasing odometer.
    const fuelRows: (typeof fuelTransactions.$inferInsert)[] = [];
    for (const [plate, base, driverId, projectId] of [["DEMO-1001", 25000, drv?.id ?? null, pA.id], ["DEMO-2001", 25000, null, pB.id]] as const) {
      for (let i = 0; i < 12; i++) {
        const liters = (38 + (i % 4) * 4).toFixed(2);
        const price = "2.330";
        fuelRows.push({ organizationId: orgId, vehicleId: byPlate(plate).id, projectId, driverId, fueledAt: at(170 - i * 14), liters, pricePerLiter: price, total: (Math.round(Number(liters) * 2.33 * 100) / 100).toFixed(2), odometer: base + 450 * (i + 1), station: "محطة تجريبية (DEMO)", createdBy: pm1.id, notes: "بيانات تجريبية" });
      }
    }
    await tx.insert(fuelTransactions).values(fuelRows);
    await tx.update(vehicles).set({ currentOdometer: 25000 + 450 * 12 }).where(inArray(vehicles.id, [byPlate("DEMO-1001").id, byPlate("DEMO-2001").id]));

    // Accidents: one open (vehicle flagged ACCIDENT), one closed with repair cost.
    const v2002 = byPlate("DEMO-2002");
    await tx.insert(accidents).values([
      { organizationId: orgId, vehicleId: v2002.id, projectId: pB.id, occurredAt: at(3, 18), location: "موقع تجريبي (DEMO)", latitude: "24.713600", longitude: "46.675300", description: "(DEMO) صدمة خفيفة في الصدام الخلفي", severity: "MINOR", responsibility: "THIRD_PARTY", status: "OPEN", vehicleStatusBefore: "AVAILABLE", createdBy: pm2.id },
      { organizationId: orgId, vehicleId: byPlate("DEMO-1001").id, projectId: pA.id, driverId: drv?.id ?? null, occurredAt: at(60, 14), location: "موقع تجريبي (DEMO)", description: "(DEMO) كسر المرآة الجانبية", severity: "MODERATE", responsibility: "DRIVER", status: "CLOSED", repairCost: "850.00", resolution: "(DEMO) تم الإصلاح على حساب الشركة", closedAt: at(50), createdBy: pm1.id },
    ]);
    await tx.update(vehicles).set({ status: "ACCIDENT" }).where(eq(vehicles.id, v2002.id));

    // Violations: open, paid, disputed.
    await tx.insert(violations).values([
      { organizationId: orgId, vehicleId: byPlate("DEMO-1001").id, projectId: pA.id, driverId: drv?.id ?? null, violationNumber: "DEMO-V001", violationDate: addDays(t, -9), type: "(DEMO) تجاوز السرعة", amount: "300.00", authority: "جهة تجريبية", status: "OPEN", createdBy: pm1.id },
      { organizationId: orgId, vehicleId: byPlate("DEMO-1001").id, projectId: pA.id, driverId: drv?.id ?? null, violationNumber: "DEMO-V002", violationDate: addDays(t, -40), type: "(DEMO) وقوف خاطئ", amount: "150.00", authority: "جهة تجريبية", status: "PAID", paymentDate: addDays(t, -35), createdBy: pm1.id },
      { organizationId: orgId, vehicleId: byPlate("DEMO-2001").id, projectId: pB.id, violationNumber: "DEMO-V003", violationDate: addDays(t, -20), type: "(DEMO) عدم ربط الحزام", amount: "150.00", authority: "جهة تجريبية", status: "DISPUTED", disputeReason: "(DEMO) السائق لم يكن في المركبة", createdBy: pm2.id },
    ]);

    // Invoices across the workflow.
    const inv = async (values: Partial<typeof invoices.$inferInsert> & { amount: string; tax: string }) => {
      const [row] = await tx.insert(invoices).values({ organizationId: orgId, projectId: pA.id, invoiceDate: addDays(t, -10), total: (Number(values.amount) + Number(values.tax)).toFixed(2), createdBy: tech.id, vendorId: vendor?.id ?? null, ...values }).returning();
      return row!;
    };
    await inv({ invoiceNumber: "DEMO-INV-001", description: "(DEMO) قطع غيار — مسودة", amount: "400.00", tax: "60.00", status: "DRAFT" });
    await inv({ invoiceNumber: "DEMO-INV-002", description: "(DEMO) صيانة دورية — بانتظار المراجعة", amount: "1200.00", tax: "180.00", status: "SUBMITTED", submittedAt: at(2), fileId: await demoFile("demo-invoice-002.pdf", tech.id), dueDate: addDays(t, 20) });
    await inv({ invoiceNumber: "DEMO-INV-003", description: "(DEMO) إطارات — بانتظار التحويل", amount: "2000.00", tax: "300.00", status: "TRANSFER_PENDING", submittedAt: at(8), approvedBy: fin.id, approvedAt: at(6), fileId: await demoFile("demo-invoice-003.pdf", tech.id), dueDate: addDays(t, -2) });
    const paid = await inv({ invoiceNumber: "DEMO-INV-004", description: "(DEMO) سمكرة — تم التحويل", amount: "900.00", tax: "135.00", status: "TRANSFERRED", projectId: pB.id, createdBy: pm2.id, submittedAt: at(30), approvedBy: fin.id, approvedAt: at(28), fileId: await demoFile("demo-invoice-004.pdf", pm2.id) });
    await tx.insert(invoiceTransfers).values({ organizationId: orgId, invoiceId: paid.id, transferDate: addDays(t, -25), amount: "1035.00", bank: "بنك تجريبي (DEMO)", reference: "DEMO-TRX-004", receiptFileId: await demoFile("demo-receipt-004.pdf", fin.id), createdBy: fin.id });
    await inv({ invoiceNumber: "DEMO-INV-005", description: "(DEMO) فاتورة مرفوضة", amount: "5000.00", tax: "750.00", status: "REJECTED", submittedAt: at(12), rejectedBy: fin.id, rejectedAt: at(11), rejectionReason: "(DEMO) المبلغ لا يطابق عرض السعر", fileId: await demoFile("demo-invoice-005.pdf", tech.id) });

    // Expenses.
    await tx.insert(expenses).values([
      { organizationId: orgId, projectId: pA.id, vehicleId: byPlate("DEMO-1001").id, category: "OTHER", amount: "120.00", expenseDate: addDays(t, -4), description: "(DEMO) غسيل المركبة", status: "SUBMITTED", createdBy: pm1.id },
      { organizationId: orgId, projectId: pB.id, vehicleId: byPlate("DEMO-2001").id, category: "OTHER", amount: "260.00", expenseDate: addDays(t, -15), description: "(DEMO) رسوم مواقف", status: "APPROVED", reviewedBy: fin.id, reviewedAt: at(14), createdBy: pm2.id },
    ]);

    // Employee documents (expiring soon / active).
    const [e3] = await tx.select().from(employees).where(eq(employees.employeeNumber, "DEMO-E003"));
    const [e1] = await tx.select().from(employees).where(eq(employees.employeeNumber, "DEMO-E001"));
    await tx.insert(employeeDocuments).values([
      { organizationId: orgId, employeeId: e3!.id, documentType: "IQAMA", documentNumber: "DEMO-IQ-0003", issueDate: addDays(t, -340), expiryDate: addDays(t, 18), notes: "بيانات تجريبية", createdBy: admin.id },
      { organizationId: orgId, employeeId: e1!.id, documentType: "PASSPORT", documentNumber: "DEMO-PP-0001", issueDate: addDays(t, -800), expiryDate: addDays(t, 900), notes: "بيانات تجريبية", createdBy: admin.id },
      { organizationId: orgId, employeeId: e1!.id, documentType: "CONTRACT", documentNumber: "DEMO-CT-0001", issueDate: addDays(t, -400), createdBy: admin.id },
    ]);

    // GPS: one finished demo trip + latest position for DEMO-1001.
    if (drv) {
      const [trip] = await tx.insert(trips).values({ organizationId: orgId, driverId: drv.id, vehicleId: byPlate("DEMO-1001").id, projectId: pA.id, userId: driverUser.id, source: "WEB", status: "ENDED", startedAt: at(1, 8), endedAt: at(1, 9), distanceMeters: "0", pointCount: 0 }).returning();
      const pts = Array.from({ length: 12 }, (_, i) => ({ lat: 24.7136 + i * 0.0021, lng: 46.6753 + i * 0.0017, at: new Date(at(1, 8).getTime() + i * 5 * 60_000) }));
      await tx.insert(locationPings).values(pts.map((p) => ({ organizationId: orgId, tripId: trip!.id, driverId: drv.id, vehicleId: byPlate("DEMO-1001").id, projectId: pA.id, latitude: p.lat.toFixed(6), longitude: p.lng.toFixed(6), accuracy: "12.00", recordedAt: p.at })));
      let dist = 0;
      for (let i = 1; i < pts.length; i++) dist += haversineMeters(pts[i - 1]!.lat, pts[i - 1]!.lng, pts[i]!.lat, pts[i]!.lng);
      await tx.update(trips).set({ distanceMeters: dist.toFixed(1), pointCount: pts.length, lastPointAt: pts[pts.length - 1]!.at }).where(eq(trips.id, trip!.id));
      const last = pts[pts.length - 1]!;
      await tx.insert(vehicleLocations).values({ vehicleId: byPlate("DEMO-1001").id, organizationId: orgId, driverId: drv.id, tripId: trip!.id, latitude: last.lat.toFixed(6), longitude: last.lng.toFixed(6), accuracy: "12.00", recordedAt: last.at }).onConflictDoNothing();

      // A pending handover link for the demo driver on DEMO-1001 (link printed once below).
      const token = randomBytes(32).toString("base64url");
      await tx.insert(handoverSessions).values({ organizationId: orgId, vehicleId: byPlate("DEMO-1001").id, driverId: drv.id, projectId: pA.id, createdBy: pm1.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + config.HANDOVER_LINK_DAYS * 86_400_000) });
      demoHandoverLink = `${config.publicAppUrl}/h/${token}`;
    }
    await tx.insert(notifications).values({ organizationId: orgId, userId: admin.id, type: "SYSTEM_BROADCAST", category: "SYSTEM", title: "(تجريبي) مرحبًا بك في بيئة العرض التجريبية لإيزي فليت" });
  });
  console.log("[seed-demo] operations/finance demo data created (fuel, accidents, violations, invoices, expenses, employee documents, GPS trip, handover link)");
}

// ---------------------------------------------------------------- phase 5: full demo company (4 cities, every status)
let fullCounts: FullDemoCounts | null = null;
const [phase5] = await db.select({ id: projects.id }).from(projects).where(eq(projects.code, FULL_DEMO_MARKER_PROJECT));
if (phase5) {
  console.log("[seed-demo] full demo company already present — skipping phase 5");
} else {
  fullCounts = await db.transaction((tx) => seedFullDemo(tx, passwordHash));
  console.log("[seed-demo] full demo company created (phase 5):");
  for (const [k, n] of Object.entries(fullCounts)) console.log(`  ${k.padEnd(20)} +${n}`);
}

// ---------------------------------------------------------------- totals of DEMO records now in the database
const demoTotals = await pool.query<{ k: string; n: number }>(`
  select 'users' k, count(*)::int n from users where lower(email) like 'demo.%@example.com'
  union all select 'projects', count(*)::int from projects where code like 'DEMO-%'
  union all select 'employees', count(*)::int from employees where employee_number like 'DEMO-%'
  union all select 'drivers', count(*)::int from drivers where license_number like 'DEMO-%'
  union all select 'vehicles', count(*)::int from vehicles where plate_number like 'DEMO-%'
  union all select 'vehicle_documents', count(*)::int from vehicle_documents d join vehicles v on v.id = d.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'insurance_policies', count(*)::int from insurance_policies i join vehicles v on v.id = i.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'maintenance_requests', count(*)::int from maintenance_requests m join vehicles v on v.id = m.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'invoices', count(*)::int from invoices where invoice_number like 'DEMO-%'
  union all select 'expenses', count(*)::int from expenses e join vehicles v on v.id = e.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'fuel_transactions', count(*)::int from fuel_transactions f join vehicles v on v.id = f.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'accidents', count(*)::int from accidents a join vehicles v on v.id = a.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'violations', count(*)::int from violations where violation_number like 'DEMO-%'
  union all select 'handover_sessions', count(*)::int from handover_sessions h join vehicles v on v.id = h.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'trips', count(*)::int from trips t join vehicles v on v.id = t.vehicle_id where v.plate_number like 'DEMO-%'
  union all select 'assignments', count(*)::int from assignments a join users u on u.id = a.assigned_to where lower(u.email) like 'demo.%@example.com'
  union all select 'notifications', count(*)::int from notifications n join users u on u.id = n.user_id where lower(u.email) like 'demo.%@example.com'
`);
console.log("\n[seed-demo] DEMO records in the database:");
for (const r of demoTotals.rows) console.log(`  ${r.k.padEnd(22)} ${r.n}`);

const accounts = [
  "demo.admin (SUPER_ADMIN)",
  "demo.pm1 / demo.pm2 / demo.pm.makkah / demo.pm.madinah (PROJECT_MANAGER)",
  "demo.finance (FINANCE)",
  "demo.tech (TECHNICAL)",
  "demo.user (USER)",
  "demo.driver / demo.driver.riyadh / demo.driver.jeddah / demo.driver.makkah / demo.driver.madinah (DRIVER)",
  "demo.viewer (VIEWER)",
];
console.log("\n[seed-demo] DEMO accounts (@example.com), all sharing one password:");
for (const a of accounts) console.log(`  - ${a}`);
if (demoPassword) console.log("  password: the value of DEMO_PASSWORD (not printed)");
else console.log(`  password (random, shown once): ${password}`);
if (demoHandoverLink && !production) console.log(`\n  DEMO handover link (driver, shown once): ${demoHandoverLink}`);
console.log("\nDemo accounts are for demonstrations only — never for real operations.\n");
await pool.end();
