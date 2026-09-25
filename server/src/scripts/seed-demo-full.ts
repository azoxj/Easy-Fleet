/**
 * DEMO SEED — phase 5 ("full demo company"). Called from seed-demo.ts after
 * phases 1–4, inside one transaction. Every record is fictitious and labelled
 * "(تجريبي)" / "(DEMO)"; codes and numbers start with "DEMO-". Nothing that
 * already exists is deleted; the only updates touch rows created by the demo
 * seed itself (plus the default organization name while it is still the
 * untouched default).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { RoleKey } from "../auth/permissions.js";
import type { DbOrTx } from "../db/client.js";
import { DEFAULT_ORG_SLUG } from "../db/bootstrap.js";
import {
  accidents,
  assignments,
  auditLogs,
  drivers,
  employeeDocuments,
  employees,
  expenses,
  files,
  fuelTransactions,
  handoverPhotos,
  handoverSessions,
  insurancePolicies,
  invoices,
  invoiceTransfers,
  locationPings,
  maintenanceEvents,
  maintenanceLabor,
  maintenanceParts,
  maintenanceQuotes,
  maintenanceRequests,
  notifications,
  organizations,
  projects,
  projectUsers,
  roles,
  trips,
  userRoles,
  users,
  vehicleDocuments,
  vehicleDriverHistory,
  vehicleLocations,
  vehicles,
  vendors,
  violations,
} from "../db/schema/index.js";
import { addDays, today } from "../lib/clock.js";
import { haversineMeters } from "../modules/operations/tracking.js";

/** Marker: phase 5 is considered applied once this project code exists. */
export const FULL_DEMO_MARKER_PROJECT = "DEMO-MKK";
export const DEMO_ORG_NAME = "Easy Fleet Demo Company";

export type FullDemoCounts = Record<string, number>;

// ---------------------------------------------------------------- tiny valid PNG writer (real image bytes)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real 320×240 RGB PNG: diagonal stripes in the given colour (DEMO placeholder photo). */
function demoPng(rgb: [number, number, number], signature = false): Buffer {
  const w = 320;
  const h = 240;
  const raw = Buffer.alloc((1 + w * 3) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      let px: [number, number, number];
      if (signature) {
        const curve = Math.round(h / 2 + Math.sin(x / 18) * 40 * Math.sin(x / 90));
        px = Math.abs(y - curve) <= 2 && x > 30 && x < w - 30 ? [20, 30, 90] : [255, 255, 255];
      } else {
        const light = (x + y) % 48 < 24;
        px = light ? rgb : [Math.min(255, rgb[0] + 40), Math.min(255, rgb[1] + 40), Math.min(255, rgb[2] + 40)];
      }
      raw[row + 1 + x * 3] = px[0];
      raw[row + 2 + x * 3] = px[1];
      raw[row + 3 + x * 3] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function seedFullDemo(tx: DbOrTx, passwordHash: string): Promise<FullDemoCounts> {
  const counts: FullDemoCounts = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  const t = today();
  const at = (daysAgo: number, hour = 9, minute = 0) =>
    new Date(`${addDays(t, -daysAgo)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+03:00`);
  const d = (offset: number) => addDays(t, offset);

  // ---------------------------------------------------------------- organization
  const [org] = await tx.select().from(organizations).where(eq(organizations.slug, DEFAULT_ORG_SLUG));
  const orgId = org!.id;
  // Only rename while the organization still carries the untouched default profile.
  await tx
    .update(organizations)
    .set({ name: DEMO_ORG_NAME, legalName: `${DEMO_ORG_NAME} (DEMO)`, address: "الرياض — عنوان تجريبي (DEMO)", email: "info@example.com", updatedAt: new Date() })
    .where(and(eq(organizations.id, orgId), eq(organizations.name, "Easy Fleet"), isNull(organizations.legalName)));

  // ---------------------------------------------------------------- audit helper (append-only inserts)
  const log = async (
    action: string,
    entity: string,
    entityId: string,
    o: { userId: string; at?: Date; projectId?: string | null; vehicleId?: string | null; newValue?: Record<string, unknown> },
  ) => {
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      userId: o.userId,
      action,
      entity,
      entityId,
      projectId: o.projectId ?? null,
      vehicleId: o.vehicleId ?? null,
      newValue: o.newValue ?? null,
      metadata: { demo: true, source: "seed-demo" },
      userAgent: "seed-demo (DEMO)",
      createdAt: o.at ?? new Date(),
    });
    bump("auditLogs");
  };

  // ---------------------------------------------------------------- users (7 roles are covered by phase 1; add more)
  const roleRows = await tx.select().from(roles).where(isNull(roles.organizationId));
  const roleId = (k: RoleKey) => roleRows.find((r) => r.key === k)!.id;
  const byEmail = async (e: string) => (await tx.select().from(users).where(sql`lower(${users.email}) = ${e}`))[0]!;
  const admin = await byEmail("demo.admin@example.com");
  const pm1 = await byEmail("demo.pm1@example.com");
  const pm2 = await byEmail("demo.pm2@example.com");
  const fin = await byEmail("demo.finance@example.com");
  const tech = await byEmail("demo.tech@example.com");
  const driverUser = await byEmail("demo.driver@example.com");
  const viewer = await byEmail("demo.viewer@example.com");
  await tx.update(users).set({ phone: "+966500000101" }).where(and(eq(users.id, admin.id), isNull(users.phone)));

  const mkUser = async (email: string, name: string, role: RoleKey, phone: string) => {
    await tx.insert(users).values({ organizationId: orgId, email, name, phone, passwordHash, createdBy: admin.id }).onConflictDoNothing();
    const u = await byEmail(email);
    await tx.insert(userRoles).values({ userId: u.id, roleId: roleId(role) }).onConflictDoNothing();
    await log("USER_CREATED", "user", u.id, { userId: admin.id, at: at(200), newValue: { email, role } });
    bump("users");
    return u;
  };
  const basicUser = await mkUser("demo.user@example.com", "مستخدم عمليات (تجريبي)", "USER", "+966500000102");
  const pmMkk = await mkUser("demo.pm.makkah@example.com", "مدير مشروع مكة (تجريبي)", "PROJECT_MANAGER", "+966500000103");
  const pmMed = await mkUser("demo.pm.madinah@example.com", "مدير مشروع المدينة (تجريبي)", "PROJECT_MANAGER", "+966500000104");
  const drvRuhUser = await mkUser("demo.driver.riyadh@example.com", "فهد القحطاني — سائق (تجريبي)", "DRIVER", "+966500000105");
  const drvJedUser = await mkUser("demo.driver.jeddah@example.com", "خالد الزهراني — سائق (تجريبي)", "DRIVER", "+966500000106");
  const drvMkkUser = await mkUser("demo.driver.makkah@example.com", "عبدالرحمن المالكي — سائق (تجريبي)", "DRIVER", "+966500000107");
  const drvMedUser = await mkUser("demo.driver.madinah@example.com", "نايف الحربي — سائق (تجريبي)", "DRIVER", "+966500000108");

  // ---------------------------------------------------------------- projects: Riyadh, Jeddah, Makkah, Madinah
  await tx
    .update(projects)
    .set({ name: "مشروع الرياض (تجريبي)", description: "مشروع تجريبي — أسطول منطقة الرياض (DEMO)", startDate: d(-420), updatedAt: new Date() })
    .where(and(eq(projects.organizationId, orgId), eq(projects.code, "DEMO-A"), eq(projects.name, "مشروع تجريبي أ")));
  await tx
    .update(projects)
    .set({ name: "مشروع جدة (تجريبي)", description: "مشروع تجريبي — أسطول منطقة جدة (DEMO)", startDate: d(-380), updatedAt: new Date() })
    .where(and(eq(projects.organizationId, orgId), eq(projects.code, "DEMO-B"), eq(projects.name, "مشروع تجريبي ب")));
  await tx
    .insert(projects)
    .values([
      { organizationId: orgId, name: "مشروع مكة (تجريبي)", code: "DEMO-MKK", description: "مشروع تجريبي — أسطول مكة المكرمة (DEMO)", managerId: pmMkk.id, status: "ACTIVE", startDate: d(-300), budget: "320000.00", contractValue: "450000.00", createdBy: admin.id },
      { organizationId: orgId, name: "مشروع المدينة (تجريبي)", code: "DEMO-MED", description: "مشروع تجريبي — أسطول المدينة المنورة (DEMO)", managerId: pmMed.id, status: "ACTIVE", startDate: d(-240), budget: "210000.00", contractValue: "300000.00", createdBy: admin.id },
    ])
    .onConflictDoNothing();
  const projRows = await tx.select().from(projects).where(and(eq(projects.organizationId, orgId), inArray(projects.code, ["DEMO-A", "DEMO-B", "DEMO-MKK", "DEMO-MED"])));
  const P = (code: string) => projRows.find((p) => p.code === code)!;
  const RUH = P("DEMO-A");
  const JED = P("DEMO-B");
  const MKK = P("DEMO-MKK");
  const MED = P("DEMO-MED");
  for (const p of [MKK, MED]) await log("PROJECT_CREATED", "project", p.id, { userId: admin.id, at: at(p === MKK ? 300 : 240), projectId: p.id, newValue: { code: p.code, name: p.name } });
  bump("projects", 2);
  const pmOf: Record<string, string> = { [RUH.id]: pm1.id, [JED.id]: pm2.id, [MKK.id]: pmMkk.id, [MED.id]: pmMed.id };

  const members: [string, string][] = [
    [MKK.id, pmMkk.id],
    [MED.id, pmMed.id],
    [MKK.id, tech.id],
    [MED.id, tech.id],
    [RUH.id, basicUser.id],
    [JED.id, basicUser.id],
    [RUH.id, viewer.id],
    [JED.id, viewer.id],
    [MKK.id, viewer.id],
    [MED.id, viewer.id],
  ];
  await tx.insert(projectUsers).values(members.map(([projectId, userId]) => ({ projectId, userId, addedBy: admin.id }))).onConflictDoNothing();

  // ---------------------------------------------------------------- vendors
  const vendorDefs = [
    { name: "مركز الصيانة المتقدمة (DEMO)", phone: "+966500000201", taxNumber: "300000000000013" },
    { name: "قطع غيار الخليج (DEMO)", phone: "+966500000202", taxNumber: "300000000000023" },
    { name: "إطارات الوسطى (DEMO)", phone: "+966500000203", taxNumber: "300000000000033" },
  ];
  await tx
    .insert(vendors)
    .values(vendorDefs.map((v) => ({ organizationId: orgId, ...v, email: "vendor@example.com", address: "عنوان تجريبي (DEMO)", notes: "مورد تجريبي — ليس جهة حقيقية", createdBy: admin.id })))
    .onConflictDoNothing();
  const vendorRows = await tx.select().from(vendors).where(eq(vendors.organizationId, orgId));
  const V = (name: string) => vendorRows.find((v) => v.name === name)!;
  const vWorkshop = V("ورشة تجريبية (DEMO)");
  const vAdv = V("مركز الصيانة المتقدمة (DEMO)");
  const vParts = V("قطع غيار الخليج (DEMO)");
  const vTires = V("إطارات الوسطى (DEMO)");
  bump("vendors", 3);

  // ---------------------------------------------------------------- vehicles (5 from phases 1–4 + 12 new = 17)
  const vin = (plate: string) => `DEMVTEST${plate.replace(/\D/g, "").padStart(9, "0")}`;
  const upgrade: Record<string, { make: string; model: string; year: number; color: string }> = {
    "DEMO-1001": { make: "Toyota", model: "Camry", year: 2023, color: "أبيض" },
    "DEMO-1002": { make: "Mitsubishi", model: "L200", year: 2022, color: "فضي" },
    "DEMO-2001": { make: "Toyota", model: "Hiace", year: 2024, color: "أبيض" },
    "DEMO-2002": { make: "Isuzu", model: "NPR", year: 2020, color: "أبيض" },
    "DEMO-9001": { make: "Suzuki", model: "Dzire", year: 2021, color: "رمادي" },
  };
  for (const [plate, u] of Object.entries(upgrade)) {
    await tx
      .update(vehicles)
      .set({ ...u, vin: sql`coalesce(${vehicles.vin}, ${vin(plate)})`, updatedAt: new Date() })
      .where(and(eq(vehicles.organizationId, orgId), eq(vehicles.plateNumber, plate), eq(vehicles.make, "تجريبي")));
  }
  // Keep the demo statuses coherent with the older phases' records.
  await tx.update(vehicles).set({ status: "IN_MAINTENANCE" }).where(and(eq(vehicles.organizationId, orgId), eq(vehicles.plateNumber, "DEMO-2001"), eq(vehicles.status, "AVAILABLE")));
  await tx
    .update(vehicles)
    .set({ status: "OUT_OF_SERVICE", notes: "(DEMO) خارج الخدمة بانتظار قرار البيع" })
    .where(and(eq(vehicles.organizationId, orgId), eq(vehicles.plateNumber, "DEMO-9001"), eq(vehicles.status, "AVAILABLE"), isNull(vehicles.assignedDriverId)));

  type NewVehicle = { plate: string; ar: string; make: string; model: string; year: number; color: string; project: string; odo: number; status: (typeof vehicles.$inferInsert)["status"]; price: string };
  const newVehicles: NewVehicle[] = [
    { plate: "DEMO-3101", ar: "ر ي ض 3101", make: "Nissan", model: "Patrol", year: 2024, color: "أسود", project: RUH.id, odo: 18200, status: "ASSIGNED", price: "285000.00" },
    { plate: "DEMO-3102", ar: "ر ي ض 3102", make: "Geely", model: "Coolray", year: 2023, color: "أحمر", project: RUH.id, odo: 31400, status: "AVAILABLE", price: "89000.00" },
    { plate: "DEMO-3103", ar: "ر ي ض 3103", make: "Toyota", model: "Camry", year: 2022, color: "أبيض", project: RUH.id, odo: 54800, status: "ASSIGNED", price: "118000.00" },
    { plate: "DEMO-3201", ar: "ج د ه 3201", make: "Toyota", model: "Hiace", year: 2023, color: "أبيض", project: JED.id, odo: 42100, status: "ASSIGNED", price: "142000.00" },
    { plate: "DEMO-3202", ar: "ج د ه 3202", make: "Mitsubishi", model: "Canter", year: 2021, color: "أبيض", project: JED.id, odo: 97300, status: "ACCIDENT", price: "155000.00" },
    { plate: "DEMO-3203", ar: "ج د ه 3203", make: "Suzuki", model: "Ertiga", year: 2024, color: "رمادي", project: JED.id, odo: 12600, status: "ASSIGNED", price: "76000.00" },
    { plate: "DEMO-3301", ar: "م ك ه 3301", make: "Isuzu", model: "D-Max", year: 2023, color: "أبيض", project: MKK.id, odo: 38900, status: "ASSIGNED", price: "109000.00" },
    { plate: "DEMO-3302", ar: "م ك ه 3302", make: "Toyota", model: "Camry", year: 2024, color: "فضي", project: MKK.id, odo: 15700, status: "ASSIGNED", price: "124000.00" },
    { plate: "DEMO-3303", ar: "م ك ه 3303", make: "Geely", model: "Emgrand", year: 2023, color: "أزرق", project: MKK.id, odo: 27500, status: "AVAILABLE", price: "72000.00" },
    { plate: "DEMO-3401", ar: "م د ن 3401", make: "Nissan", model: "Patrol", year: 2022, color: "أبيض", project: MED.id, odo: 66400, status: "ASSIGNED", price: "260000.00" },
    { plate: "DEMO-3402", ar: "م د ن 3402", make: "Toyota", model: "Hiace", year: 2022, color: "أبيض", project: MED.id, odo: 88100, status: "ACCIDENT", price: "138000.00" },
    { plate: "DEMO-3403", ar: "م د ن 3403", make: "Mitsubishi", model: "Pajero", year: 2021, color: "ذهبي", project: MED.id, odo: 102300, status: "IN_MAINTENANCE", price: "131000.00" },
  ];
  await tx
    .insert(vehicles)
    .values(
      newVehicles.map((v, i) => ({
        organizationId: orgId,
        plateNumber: v.plate,
        plateArabic: v.ar,
        plateEnglish: `DMO ${v.plate.slice(5)}`,
        serialNumber: `9${v.plate.slice(5).padStart(8, "0")}`,
        vehicleNumber: `DEMO-FLEET-${String(i + 101)}`,
        make: v.make,
        model: v.model,
        year: v.year,
        color: v.color,
        vin: vin(v.plate),
        currentOdometer: v.odo,
        status: v.status,
        projectId: v.project,
        purchaseDate: d(-(v.year === 2024 ? 250 : 700 + i * 20)),
        purchasePrice: v.price,
        notes: "مركبة تجريبية (DEMO)",
        createdBy: admin.id,
      })),
    )
    .onConflictDoNothing();
  const allPlates = [...Object.keys(upgrade), ...newVehicles.map((v) => v.plate)];
  const vehicleRows = await tx.select().from(vehicles).where(and(eq(vehicles.organizationId, orgId), inArray(vehicles.plateNumber, allPlates)));
  const VH = (plate: string) => vehicleRows.find((v) => v.plateNumber === plate)!;
  for (const v of newVehicles) await log("VEHICLE_CREATED", "vehicle", VH(v.plate).id, { userId: admin.id, at: at(260), projectId: v.project, vehicleId: VH(v.plate).id, newValue: { plateNumber: v.plate, make: v.make, model: v.model } });
  bump("vehicles", newVehicles.length);

  // ---------------------------------------------------------------- employees (fictitious Arabic names) & drivers
  const empDefs: { no: string; name: string; job: string; project: string; status: "ACTIVE" | "INACTIVE"; hire: number; user?: string }[] = [
    { no: "DEMO-E006", name: "فهد سالم القحطاني (تجريبي)", job: "سائق", project: RUH.id, status: "ACTIVE", hire: 600, user: drvRuhUser.id },
    { no: "DEMO-E007", name: "ماجد علي الشهري (تجريبي)", job: "سائق", project: RUH.id, status: "ACTIVE", hire: 480 },
    { no: "DEMO-E008", name: "خالد عمر الزهراني (تجريبي)", job: "سائق", project: JED.id, status: "ACTIVE", hire: 520, user: drvJedUser.id },
    { no: "DEMO-E009", name: "ياسر حسن الغامدي (تجريبي)", job: "سائق", project: JED.id, status: "ACTIVE", hire: 350 },
    { no: "DEMO-E010", name: "عبدالرحمن ناصر المالكي (تجريبي)", job: "سائق", project: MKK.id, status: "ACTIVE", hire: 290, user: drvMkkUser.id },
    { no: "DEMO-E011", name: "سعيد محمد العمري (تجريبي)", job: "سائق", project: MKK.id, status: "ACTIVE", hire: 280 },
    { no: "DEMO-E012", name: "نايف فيصل الحربي (تجريبي)", job: "سائق", project: MED.id, status: "ACTIVE", hire: 230, user: drvMedUser.id },
    { no: "DEMO-E013", name: "تركي بندر الجهني (تجريبي)", job: "سائق", project: MED.id, status: "INACTIVE", hire: 700 },
    { no: "DEMO-E014", name: "ريم عبدالله السبيعي (تجريبي)", job: "محاسبة", project: RUH.id, status: "ACTIVE", hire: 410 },
    { no: "DEMO-E015", name: "نورة سعد الدوسري (تجريبي)", job: "منسقة عمليات", project: JED.id, status: "ACTIVE", hire: 330 },
    { no: "DEMO-E016", name: "سلطان مشعل العنزي (تجريبي)", job: "فني صيانة", project: MKK.id, status: "INACTIVE", hire: 560 },
    { no: "DEMO-E017", name: "هند إبراهيم البقمي (تجريبي)", job: "مشرفة موقع", project: MED.id, status: "ACTIVE", hire: 220 },
    { no: "DEMO-E018", name: "بدر راشد المطيري (تجريبي)", job: "فني كهرباء", project: MED.id, status: "INACTIVE", hire: 640 },
  ];
  await tx
    .insert(employees)
    .values(
      empDefs.map((e, i) => ({
        organizationId: orgId,
        employeeNumber: e.no,
        fullName: e.name,
        jobTitle: e.job,
        projectId: e.project,
        status: e.status,
        hireDate: d(-e.hire),
        phone: `+9665000003${String(i + 6).padStart(2, "0")}`,
        email: `${e.no.toLowerCase()}@example.com`,
        notes: "بيانات تجريبية (DEMO)",
        createdBy: admin.id,
      })),
    )
    .onConflictDoNothing();
  const empRows = await tx.select().from(employees).where(and(eq(employees.organizationId, orgId), inArray(employees.employeeNumber, [...empDefs.map((e) => e.no), "DEMO-E001", "DEMO-E002", "DEMO-E003"])));
  const E = (no: string) => empRows.find((e) => e.employeeNumber === no)!;
  for (const e of empDefs) {
    if (e.user) await tx.update(employees).set({ userId: e.user }).where(and(eq(employees.id, E(e.no).id), isNull(employees.userId)));
    await log("EMPLOYEE_CREATED", "employee", E(e.no).id, { userId: admin.id, at: at(e.hire), projectId: e.project, newValue: { employeeNumber: e.no } });
  }
  bump("employees", empDefs.length);

  const drvDefs: { no: string; lic: string; type: "PRIVATE" | "PUBLIC" | "HEAVY"; expiry: number; status?: "INACTIVE" }[] = [
    { no: "DEMO-E006", lic: "DEMO-L006", type: "PRIVATE", expiry: 540 },
    { no: "DEMO-E007", lic: "DEMO-L007", type: "PRIVATE", expiry: 22 },
    { no: "DEMO-E008", lic: "DEMO-L008", type: "PUBLIC", expiry: 310 },
    { no: "DEMO-E009", lic: "DEMO-L009", type: "PRIVATE", expiry: -6 },
    { no: "DEMO-E010", lic: "DEMO-L010", type: "HEAVY", expiry: 190 },
    { no: "DEMO-E011", lic: "DEMO-L011", type: "PRIVATE", expiry: 11 },
    { no: "DEMO-E012", lic: "DEMO-L012", type: "PUBLIC", expiry: 720 },
    { no: "DEMO-E013", lic: "DEMO-L013", type: "HEAVY", expiry: -120, status: "INACTIVE" },
  ];
  await tx
    .insert(drivers)
    .values(
      drvDefs.map((x) => ({
        organizationId: orgId,
        employeeId: E(x.no).id,
        licenseNumber: x.lic,
        licenseType: x.type,
        licenseIssueDate: d(x.expiry - 1825),
        licenseExpiryDate: d(x.expiry),
        status: x.status ?? ("ACTIVE" as const),
        notes: "رخصة تجريبية (DEMO)",
        createdBy: admin.id,
      })),
    )
    .onConflictDoNothing();
  const drvRows = await tx
    .select({ id: drivers.id, no: employees.employeeNumber })
    .from(drivers)
    .innerJoin(employees, eq(employees.id, drivers.employeeId))
    .where(and(eq(drivers.organizationId, orgId), inArray(employees.employeeNumber, [...drvDefs.map((x) => x.no), "DEMO-E002", "DEMO-E003"])));
  const D = (no: string) => drvRows.find((x) => x.no === no)!.id;
  for (const x of drvDefs) await log("DRIVER_CREATED", "driver", D(x.no), { userId: admin.id, at: at(220), newValue: { licenseNumber: x.lic } });
  bump("drivers", drvDefs.length);

  // ---------------------------------------------------------------- driver ↔ vehicle history
  const history: { plate: string; drv: string; from: number; to?: number }[] = [
    { plate: "DEMO-1002", drv: "DEMO-E002", from: 300, to: 100 },
    { plate: "DEMO-3401", drv: "DEMO-E013", from: 180, to: 60 },
    { plate: "DEMO-3303", drv: "DEMO-E010", from: 250, to: 120 },
    { plate: "DEMO-3102", drv: "DEMO-E007", from: 40, to: 5 },
    { plate: "DEMO-3101", drv: "DEMO-E006", from: 160 },
    { plate: "DEMO-3103", drv: "DEMO-E007", from: 4 },
    { plate: "DEMO-3201", drv: "DEMO-E008", from: 20 },
    { plate: "DEMO-3203", drv: "DEMO-E009", from: 90 },
    { plate: "DEMO-3301", drv: "DEMO-E010", from: 110 },
    { plate: "DEMO-3302", drv: "DEMO-E011", from: 30 },
    { plate: "DEMO-3401", drv: "DEMO-E012", from: 58 },
  ];
  for (const h of history) {
    const veh = VH(h.plate);
    const current = h.to === undefined;
    if (current) {
      // Respect the one-current-driver rules: only assign if both sides are free.
      const [busy] = await tx
        .select({ id: vehicleDriverHistory.id })
        .from(vehicleDriverHistory)
        .where(and(isNull(vehicleDriverHistory.unassignedAt), sql`(${vehicleDriverHistory.vehicleId} = ${veh.id} or ${vehicleDriverHistory.driverId} = ${D(h.drv)})`));
      if (busy) continue;
      await tx.update(vehicles).set({ assignedDriverId: D(h.drv) }).where(eq(vehicles.id, veh.id));
    }
    await tx.insert(vehicleDriverHistory).values({
      organizationId: orgId,
      vehicleId: veh.id,
      driverId: D(h.drv),
      assignedBy: pmOf[veh.projectId ?? ""] ?? admin.id,
      assignedAt: at(h.from, 10),
      unassignedBy: current ? null : (pmOf[veh.projectId ?? ""] ?? admin.id),
      unassignedAt: current ? null : at(h.to!, 16),
    });
    await log("VEHICLE_DRIVER_CHANGED", "vehicle", veh.id, { userId: pmOf[veh.projectId ?? ""] ?? admin.id, at: at(h.from, 10), projectId: veh.projectId, vehicleId: veh.id, newValue: { driverId: D(h.drv) } });
    bump("driverHistory");
  }

  // ---------------------------------------------------------------- vehicle documents: registration, insurance, periodic inspection
  const regOffsets = [240, 18, -15, 120, 7, -45, 300, 25, 60, -3, 180, 10, 95, 400, 29, -60, 150];
  const insOffsets = [200, -8, 27, 330, 14, 75, -30, 5, 260, 45, -2, 120, 19, 88, 365, -11, 60];
  const fahsOffsets = [90, 3, -20, 45, 160, 12, -5, 210, 26, -40, 70, 8, 300, -1, 15, 130, 55];
  for (const [i, plate] of allPlates.entries()) {
    const veh = VH(plate);
    const [reg] = await tx
      .select({ id: vehicleDocuments.id })
      .from(vehicleDocuments)
      .where(and(eq(vehicleDocuments.vehicleId, veh.id), eq(vehicleDocuments.documentType, "REGISTRATION"), isNull(vehicleDocuments.supersededAt), isNull(vehicleDocuments.deletedAt)));
    if (!reg) {
      const off = regOffsets[i]!;
      await tx.insert(vehicleDocuments).values({ organizationId: orgId, vehicleId: veh.id, documentType: "REGISTRATION", documentNumber: `DEMO-R${plate.slice(5)}`, issueDate: d(off - 365), expiryDate: d(off), issuer: "جهة ترخيص تجريبية (DEMO)", fee: "150.00", notes: "استمارة تجريبية (DEMO)", createdBy: admin.id });
      await log("REGISTRATION_ADDED", "vehicle_document", veh.id, { userId: admin.id, at: at(Math.max(1, 365 - off)), projectId: veh.projectId, vehicleId: veh.id });
      bump("registrations");
    }
    const [ins] = await tx.select({ id: insurancePolicies.id }).from(insurancePolicies).where(and(eq(insurancePolicies.vehicleId, veh.id), isNull(insurancePolicies.supersededAt)));
    if (!ins) {
      const off = insOffsets[i]!;
      await tx.insert(insurancePolicies).values({ organizationId: orgId, vehicleId: veh.id, provider: "شركة تأمين تجريبية (DEMO)", policyNumber: `DEMO-P${plate.slice(5)}`, issueDate: d(off - 365), expiryDate: d(off), premiumAmount: (1800 + (i % 5) * 450).toFixed(2), coverageType: i % 3 === 0 ? "THIRD_PARTY" : "COMPREHENSIVE", notes: "وثيقة تأمين تجريبية (DEMO)", createdBy: admin.id });
      await log("INSURANCE_ADDED", "insurance_policy", veh.id, { userId: admin.id, at: at(Math.max(1, 365 - off)), projectId: veh.projectId, vehicleId: veh.id });
      bump("insurancePolicies");
    }
    const off = fahsOffsets[i]!;
    await tx.insert(vehicleDocuments).values({ organizationId: orgId, vehicleId: veh.id, documentType: "OTHER", documentNumber: `DEMO-FAHS-${plate.slice(5)}`, issueDate: d(off - 365), expiryDate: d(off), issuer: "مركز فحص دوري تجريبي (DEMO)", fee: "115.00", notes: "الفحص الفني الدوري (DEMO)", createdBy: admin.id });
    bump("inspections");
  }

  // ---------------------------------------------------------------- employee documents
  const empDocs: [string, "NATIONAL_ID" | "IQAMA" | "PASSPORT" | "CONTRACT" | "DRIVING_LICENSE", number | null][] = [
    ["DEMO-E006", "DRIVING_LICENSE", 540],
    ["DEMO-E006", "NATIONAL_ID", 900],
    ["DEMO-E007", "DRIVING_LICENSE", 22],
    ["DEMO-E008", "IQAMA", 9],
    ["DEMO-E009", "DRIVING_LICENSE", -6],
    ["DEMO-E010", "IQAMA", 250],
    ["DEMO-E011", "PASSPORT", -14],
    ["DEMO-E012", "NATIONAL_ID", 1200],
    ["DEMO-E014", "CONTRACT", null],
    ["DEMO-E015", "IQAMA", 27],
    ["DEMO-E017", "CONTRACT", null],
  ];
  await tx.insert(employeeDocuments).values(
    empDocs.map(([no, type, exp], i) => ({
      organizationId: orgId,
      employeeId: E(no).id,
      documentType: type,
      documentNumber: `DEMO-${type.slice(0, 3)}-${String(i + 101)}`,
      issueDate: d((exp ?? 0) - 730),
      expiryDate: exp === null ? null : d(exp),
      notes: "مستند تجريبي (DEMO)",
      createdBy: admin.id,
    })),
  );
  bump("employeeDocuments", empDocs.length);

  // ---------------------------------------------------------------- maintenance: every status, quotes, parts, labor, events
  const chain = [
    { type: "CREATED", from: null, to: "REQUESTED", by: "req" },
    { type: "INSPECTION_STARTED", from: "REQUESTED", to: "INSPECTION", by: "tech" },
    { type: "INSPECTION_COMPLETED", from: "INSPECTION", to: "QUOTE_PENDING", by: "tech" },
    { type: "STATUS_CHANGED", from: "QUOTE_PENDING", to: "PENDING_APPROVAL", by: "tech" },
    { type: "APPROVED", from: "PENDING_APPROVAL", to: "APPROVED", by: "pm" },
    { type: "REPAIR_STARTED", from: "APPROVED", to: "IN_REPAIR", by: "tech" },
    { type: "READY_FOR_HANDOVER", from: "IN_REPAIR", to: "READY_FOR_HANDOVER", by: "tech" },
    { type: "HANDOVER_ACCEPTED", from: "READY_FOR_HANDOVER", to: "ACCEPTED", by: "pm" },
    { type: "CLOSED", from: "ACCEPTED", to: "CLOSED", by: "pm" },
  ] as const;
  type MStatus = (typeof maintenanceRequests.$inferInsert)["status"] & string;
  const order: MStatus[] = ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED", "CLOSED"];
  const mrs: Record<string, typeof maintenanceRequests.$inferSelect> = {};
  const mkMr = async (key: string, plate: string, o: { status: MStatus; issue: string; priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; created: number; done: number; diagnosis?: string; work?: string; rejectReason?: string; assign?: boolean }) => {
    const veh = VH(plate);
    const pm = pmOf[veh.projectId!]!;
    const idx = o.status === "REJECTED" ? 0 : order.indexOf(o.status);
    const reached = (s: MStatus) => o.status !== "REJECTED" && idx >= order.indexOf(s);
    const steps = chain.slice(0, idx + 1);
    const stepAt = (i: number) => new Date(at(o.created, 8).getTime() + ((at(o.done, 15).getTime() - at(o.created, 8).getTime()) * i) / Math.max(1, steps.length - 1 + (o.status === "REJECTED" ? 1 : 0)));
    const tsOf = (s: MStatus) => (reached(s) ? stepAt(order.indexOf(s)) : null);
    const assigned = o.assign !== false && (idx >= 1 || o.status === "REJECTED") ? tech.id : null;
    const [mr] = await tx
      .insert(maintenanceRequests)
      .values({
        organizationId: orgId,
        vehicleId: veh.id,
        projectId: veh.projectId,
        requestedBy: pm,
        assignedTo: o.status === "REJECTED" ? null : assigned,
        issue: o.issue,
        description: "طلب صيانة تجريبي (DEMO)",
        priority: o.priority,
        status: o.status,
        odometer: Math.max(0, veh.currentOdometer - 150),
        diagnosis: reached("QUOTE_PENDING") ? (o.diagnosis ?? null) : null,
        workPerformed: reached("READY_FOR_HANDOVER") ? (o.work ?? null) : null,
        rejectionReason: o.rejectReason ?? null,
        vehicleStatusBefore: reached("IN_REPAIR") ? "AVAILABLE" : null,
        assignedAt: assigned ? stepAt(1) : null,
        inspectionStartedAt: tsOf("INSPECTION"),
        approvedAt: tsOf("APPROVED"),
        startedAt: tsOf("IN_REPAIR"),
        readyAt: tsOf("READY_FOR_HANDOVER"),
        completedAt: tsOf("ACCEPTED"),
        closedAt: tsOf("CLOSED"),
        createdAt: at(o.created, 8),
        updatedAt: at(o.done, 15),
      })
      .returning();
    const actor = (by: string) => (by === "req" ? pm : by === "tech" ? tech.id : pm);
    for (const [i, s] of steps.entries()) {
      await tx.insert(maintenanceEvents).values({ organizationId: orgId, maintenanceRequestId: mr!.id, type: s.type, fromStatus: s.from, toStatus: s.to, actorId: actor(s.by), metadata: { demo: true }, createdAt: stepAt(i) });
      bump("maintenanceEvents");
    }
    if (o.status === "REJECTED") {
      await tx.insert(maintenanceEvents).values({ organizationId: orgId, maintenanceRequestId: mr!.id, type: "REJECTED", fromStatus: "REQUESTED", toStatus: "REJECTED", actorId: pm, reason: o.rejectReason ?? null, metadata: { demo: true }, createdAt: at(o.done, 15) });
      bump("maintenanceEvents");
    }
    await log("MAINTENANCE_CREATED", "maintenance_request", mr!.id, { userId: pm, at: at(o.created, 8), projectId: veh.projectId, vehicleId: veh.id, newValue: { status: "REQUESTED", issue: o.issue } });
    if (o.status !== "REQUESTED") await log("MAINTENANCE_STATUS_CHANGED", "maintenance_request", mr!.id, { userId: actor(steps[steps.length - 1]!.by), at: at(o.done, 15), projectId: veh.projectId, vehicleId: veh.id, newValue: { status: o.status } });
    if (assigned && o.status !== "REJECTED") {
      const done = o.status === "ACCEPTED" || o.status === "CLOSED";
      await tx.insert(assignments).values({ organizationId: orgId, type: "MAINTENANCE_REQUEST", assignedTo: tech.id, assignedBy: pm, projectId: veh.projectId, vehicleId: veh.id, referenceId: mr!.id, title: `صيانة MR-${mr!.number}: ${o.issue}`.slice(0, 200), priority: o.priority === "CRITICAL" ? "URGENT" : o.priority, status: done ? "COMPLETED" : "IN_PROGRESS", completedAt: done ? tsOf("ACCEPTED") : null, createdAt: stepAt(1) });
      bump("assignments");
    }
    mrs[key] = mr!;
    bump("maintenanceRequests");
    return mr!;
  };
  const quote = async (mr: typeof maintenanceRequests.$inferSelect, vendorId: string, no: string, amount: string, status: "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED", daysAgo: number, reason?: string) => {
    const reviewed = status === "APPROVED" || status === "REJECTED";
    await tx.insert(maintenanceQuotes).values({
      organizationId: orgId,
      maintenanceRequestId: mr.id,
      vendorId,
      quoteNumber: no,
      amount,
      validUntil: d(30 - daysAgo),
      status,
      notes: "عرض سعر تجريبي (DEMO)",
      createdBy: tech.id,
      submittedAt: status === "DRAFT" ? null : at(daysAgo, 11),
      reviewedBy: reviewed ? pmOf[mr.projectId!]! : null,
      reviewedAt: reviewed ? at(Math.max(0, daysAgo - 1), 12) : null,
      reviewReason: reason ?? null,
      createdAt: at(daysAgo, 10),
    });
    bump("maintenanceQuotes");
  };
  const part = async (mr: typeof maintenanceRequests.$inferSelect, name: string, no: string, qty: number, price: number, vendorId: string) => {
    await tx.insert(maintenanceParts).values({ organizationId: orgId, maintenanceRequestId: mr.id, partName: name, partNumber: no, quantity: String(qty), unitPrice: price.toFixed(2), total: sql`round(${String(qty)}::numeric * ${price.toFixed(2)}::numeric, 2)`, vendorId, createdBy: tech.id });
    bump("maintenanceParts");
  };
  const labor = async (mr: typeof maintenanceRequests.$inferSelect, desc: string, hours: number, rate: number) => {
    await tx.insert(maintenanceLabor).values({ organizationId: orgId, maintenanceRequestId: mr.id, description: desc, hours: String(hours), hourlyRate: rate.toFixed(2), total: sql`round(${String(hours)}::numeric * ${rate.toFixed(2)}::numeric, 2)`, createdBy: tech.id });
    bump("maintenanceLabor");
  };

  await mkMr("req", "DEMO-3202", { status: "REQUESTED", issue: "(DEMO) فحص الهيكل بعد صدمة أمامية", priority: "HIGH", created: 2, done: 2 });
  await mkMr("req2", "DEMO-3401", { status: "REQUESTED", issue: "(DEMO) فحص الإطارات قبل رحلة طويلة", priority: "LOW", created: 1, done: 1 });
  await mkMr("insp", "DEMO-3303", { status: "INSPECTION", issue: "(DEMO) ضعف في تبريد المكيف", priority: "MEDIUM", created: 6, done: 5 });
  const mQuote = await mkMr("quote", "DEMO-3102", { status: "QUOTE_PENDING", issue: "(DEMO) صوت في نظام التعليق الأمامي", priority: "MEDIUM", created: 9, done: 7, diagnosis: "(DEMO) تلف جلب المقصات الأمامية" });
  await quote(mQuote, vParts.id, "DEMO-Q-201", "1450.00", "DRAFT", 7);
  const mPend = await mkMr("pending", "DEMO-3302", { status: "PENDING_APPROVAL", issue: "(DEMO) تغيير زيت القير والفلاتر", priority: "HIGH", created: 12, done: 8, diagnosis: "(DEMO) زيت القير متغير اللون" });
  await quote(mPend, vAdv.id, "DEMO-Q-202", "2100.00", "SUBMITTED", 9);
  await quote(mPend, vWorkshop.id, "DEMO-Q-203", "1850.00", "UNDER_REVIEW", 8);
  const mAppr = await mkMr("approved", "DEMO-3203", { status: "APPROVED", issue: "(DEMO) تبديل الإطارات الأربعة", priority: "MEDIUM", created: 15, done: 3, diagnosis: "(DEMO) تآكل الإطارات تجاوز الحد المسموح" });
  await quote(mAppr, vTires.id, "DEMO-Q-204", "2400.00", "APPROVED", 5);
  await quote(mAppr, vAdv.id, "DEMO-Q-205", "2900.00", "REJECTED", 6, "(DEMO) السعر أعلى من العرض المعتمد");
  const mRepair = await mkMr("repair", "DEMO-3403", { status: "IN_REPAIR", issue: "(DEMO) إصلاح أضرار الحادث — الصدام والرفرف", priority: "CRITICAL", created: 20, done: 8, diagnosis: "(DEMO) كسر الصدام الأمامي والرفرف الأيمن" });
  await quote(mRepair, vAdv.id, "DEMO-Q-206", "5200.00", "APPROVED", 14);
  await part(mRepair, "(DEMO) صدام أمامي", "DEMO-BMP-01", 1, 2400, vParts.id);
  await part(mRepair, "(DEMO) رفرف أيمن", "DEMO-FND-02", 1, 1350, vParts.id);
  await labor(mRepair, "(DEMO) سمكرة ودهان", 8, 150);
  const mAcc = await mkMr("accepted", "DEMO-3101", { status: "ACCEPTED", issue: "(DEMO) صيانة دورية 20,000 كم", priority: "MEDIUM", created: 10, done: 3, diagnosis: "(DEMO) صيانة دورية حسب جدول الوكيل", work: "(DEMO) تغيير الزيت والفلاتر وفحص شامل" });
  await quote(mAcc, vWorkshop.id, "DEMO-Q-208", "980.00", "APPROVED", 8);
  await part(mAcc, "(DEMO) زيت محرك 5W-30", "DEMO-OIL-04", 6, 45, vParts.id);
  await part(mAcc, "(DEMO) فلتر زيت", "DEMO-FLT-05", 1, 65, vParts.id);
  await labor(mAcc, "(DEMO) صيانة دورية", 2.5, 140);
  const mClosed1 = await mkMr("closed1", "DEMO-3301", { status: "CLOSED", issue: "(DEMO) تغيير البطارية والدينامو", priority: "HIGH", created: 45, done: 30, diagnosis: "(DEMO) ضعف الشحن", work: "(DEMO) تم تغيير البطارية والدينامو" });
  await quote(mClosed1, vParts.id, "DEMO-Q-209", "1650.00", "APPROVED", 42);
  await part(mClosed1, "(DEMO) بطارية 70 أمبير", "DEMO-BAT-06", 1, 480, vParts.id);
  await part(mClosed1, "(DEMO) دينامو", "DEMO-ALT-07", 1, 900, vParts.id);
  await labor(mClosed1, "(DEMO) تركيب وفحص كهرباء", 2, 135);
  const mClosed2 = await mkMr("closed2", "DEMO-3401", { status: "CLOSED", issue: "(DEMO) إصلاح تسريب الرديتر", priority: "MEDIUM", created: 80, done: 70, diagnosis: "(DEMO) شرخ في خزان الرديتر", work: "(DEMO) تم تغيير الرديتر" });
  await quote(mClosed2, vAdv.id, "DEMO-Q-210", "1300.00", "APPROVED", 78);
  await part(mClosed2, "(DEMO) رديتر", "DEMO-RAD-08", 1, 950, vParts.id);
  await labor(mClosed2, "(DEMO) فك وتركيب الرديتر", 2.5, 140);
  const mClosed3 = await mkMr("closed3", "DEMO-1001", { status: "CLOSED", issue: "(DEMO) تغيير المساحات والأضواء", priority: "LOW", created: 130, done: 125, diagnosis: "(DEMO) تلف المساحات", work: "(DEMO) تم التغيير" });
  await part(mClosed3, "(DEMO) مساحات", "DEMO-WPR-09", 2, 60, vParts.id);
  await labor(mClosed3, "(DEMO) تركيب", 1, 120);
  await mkMr("rejected", "DEMO-3103", { status: "REJECTED", issue: "(DEMO) طلب تركيب إكسسوارات", priority: "LOW", created: 19, done: 18, rejectReason: "(DEMO) ليس من أعمال الصيانة المعتمدة", assign: false });

  // ---------------------------------------------------------------- demo files (real bytes, private storage)
  const saveFile = async (name: string, mime: string, body: Buffer, uploadedBy: string | null) => {
    const key = `${orgId}/${randomUUID()}`;
    const full = path.join(path.resolve(config.STORAGE_DIR), key);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, body, { mode: 0o600, flag: "wx" });
    const [f] = await tx.insert(files).values({ organizationId: orgId, storageKey: key, originalName: name, mimeType: mime, sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), uploadedBy }).returning();
    bump("files");
    return f!.id;
  };
  const pdf = (name: string, by: string) => saveFile(name, "application/pdf", Buffer.from(`%PDF-1.4\n% DEMO file (${name}) — not a real document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`), by);

  // ---------------------------------------------------------------- invoices: every status (+ transfers)
  const invoiceIds: Record<string, string> = {};
  const inv = async (no: string, o: { project: string; plate: string; vendor: string; desc: string; amount: number; status: (typeof invoices.$inferInsert)["status"] & string; days: number; due?: number; mr?: string; reason?: string }) => {
    const tax = Math.round(o.amount * 15) / 100;
    const s = o.status;
    const submitted = s !== "DRAFT" && s !== "CANCELLED";
    const approved = ["APPROVED", "TRANSFER_PENDING", "TRANSFERRED", "PAID"].includes(s);
    const creator = pmOf[o.project]!;
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        projectId: o.project,
        vehicleId: VH(o.plate).id,
        vendorId: o.vendor,
        maintenanceRequestId: o.mr ? mrs[o.mr]!.id : null,
        invoiceNumber: no,
        description: o.desc,
        amount: o.amount.toFixed(2),
        tax: tax.toFixed(2),
        total: (o.amount + tax).toFixed(2),
        invoiceDate: d(-o.days),
        dueDate: o.due === undefined ? d(30 - o.days) : d(o.due),
        status: s,
        fileId: submitted ? await pdf(`${no.toLowerCase()}.pdf`, creator) : null,
        createdBy: creator,
        submittedAt: submitted ? at(o.days - 1 >= 0 ? o.days - 1 : 0, 10) : null,
        reviewStartedBy: s === "UNDER_REVIEW" || approved || s === "REJECTED" ? fin.id : null,
        approvedBy: approved ? fin.id : null,
        approvedAt: approved ? at(Math.max(0, o.days - 2), 12) : null,
        rejectedBy: s === "REJECTED" ? fin.id : null,
        rejectedAt: s === "REJECTED" ? at(Math.max(0, o.days - 2), 12) : null,
        rejectionReason: s === "REJECTED" ? (o.reason ?? null) : null,
        cancelledAt: s === "CANCELLED" ? at(Math.max(0, o.days - 1), 13) : null,
        paidAt: s === "PAID" ? at(Math.max(0, o.days - 5), 14) : null,
        createdAt: at(o.days, 9),
      })
      .returning();
    if (s === "TRANSFERRED" || s === "PAID") {
      await tx.insert(invoiceTransfers).values({ organizationId: orgId, invoiceId: row!.id, transferDate: d(-Math.max(0, o.days - 4)), amount: row!.total, bank: "بنك تجريبي (DEMO)", reference: `DEMO-TRX-${no.slice(-3)}`, receiptFileId: await pdf(`receipt-${no.toLowerCase()}.pdf`, fin.id), createdBy: fin.id, createdAt: at(Math.max(0, o.days - 4), 11) });
      bump("invoiceTransfers");
    }
    await log("INVOICE_CREATED", "invoice", row!.id, { userId: creator, at: at(o.days, 9), projectId: o.project, vehicleId: VH(o.plate).id, newValue: { status: "DRAFT", total: row!.total } });
    if (s !== "DRAFT") await log("INVOICE_STATUS_CHANGED", "invoice", row!.id, { userId: s === "CANCELLED" ? creator : fin.id, at: at(Math.max(0, o.days - 2), 12), projectId: o.project, vehicleId: VH(o.plate).id, newValue: { status: s } });
    invoiceIds[no] = row!.id;
    bump("invoices");
    return row!;
  };
  await inv("DEMO-INV-101", { project: JED.id, plate: "DEMO-3202", vendor: vParts.id, desc: "(DEMO) قطع غيار هيكل — مسودة", amount: 750, status: "DRAFT", days: 1 });
  await inv("DEMO-INV-102", { project: MKK.id, plate: "DEMO-3302", vendor: vAdv.id, desc: "(DEMO) زيت قير وفلاتر — مقدمة", amount: 2100, status: "SUBMITTED", days: 4, due: 25 });
  await inv("DEMO-INV-103", { project: MED.id, plate: "DEMO-3403", vendor: vAdv.id, desc: "(DEMO) سمكرة ودهان — قيد المراجعة", amount: 5200, status: "UNDER_REVIEW", days: 6, due: 10 });
  await inv("DEMO-INV-104", { project: RUH.id, plate: "DEMO-3101", vendor: vWorkshop.id, desc: "(DEMO) صيانة دورية — معتمدة", amount: 980, status: "APPROVED", days: 3, mr: "accepted" });
  await inv("DEMO-INV-105", { project: JED.id, plate: "DEMO-3203", vendor: vTires.id, desc: "(DEMO) إطارات — بانتظار التحويل", amount: 2400, status: "TRANSFER_PENDING", days: 5, due: -1 });
  await inv("DEMO-INV-106", { project: MED.id, plate: "DEMO-3401", vendor: vAdv.id, desc: "(DEMO) رديتر — تم التحويل", amount: 1300, status: "TRANSFERRED", days: 68, mr: "closed2" });
  await inv("DEMO-INV-107", { project: MKK.id, plate: "DEMO-3301", vendor: vParts.id, desc: "(DEMO) بطارية ودينامو — مدفوعة", amount: 1650, status: "PAID", days: 32, mr: "closed1" });
  await inv("DEMO-INV-108", { project: RUH.id, plate: "DEMO-1001", vendor: vWorkshop.id, desc: "(DEMO) مساحات وأضواء — مدفوعة", amount: 240, status: "PAID", days: 124, mr: "closed3" });
  await inv("DEMO-INV-109", { project: JED.id, plate: "DEMO-3201", vendor: vParts.id, desc: "(DEMO) فاتورة مرفوضة", amount: 3100, status: "REJECTED", days: 14, reason: "(DEMO) لا يوجد عرض سعر معتمد" });
  await inv("DEMO-INV-110", { project: RUH.id, plate: "DEMO-3103", vendor: vWorkshop.id, desc: "(DEMO) فاتورة ملغاة — أُدخلت بالخطأ", amount: 600, status: "CANCELLED", days: 18 });
  await inv("DEMO-INV-111", { project: MKK.id, plate: "DEMO-3303", vendor: vTires.id, desc: "(DEMO) إطارات — مدفوعة", amount: 1800, status: "PAID", days: 95 });
  await inv("DEMO-INV-112", { project: MED.id, plate: "DEMO-3402", vendor: vAdv.id, desc: "(DEMO) صيانة مكيف — مدفوعة", amount: 1150, status: "PAID", days: 150 });
  await inv("DEMO-INV-113", { project: JED.id, plate: "DEMO-3201", vendor: vWorkshop.id, desc: "(DEMO) فحص وصيانة — تم التحويل", amount: 870, status: "TRANSFERRED", days: 110 });
  await inv("DEMO-INV-114", { project: RUH.id, plate: "DEMO-3102", vendor: vParts.id, desc: "(DEMO) قطع تعليق — معتمدة", amount: 1450, status: "APPROVED", days: 2 });

  // ---------------------------------------------------------------- expenses
  const expDefs: [string, string, "FUEL" | "MAINTENANCE" | "INSURANCE" | "REGISTRATION" | "ACCIDENT" | "VIOLATION" | "OTHER", number, number, "SUBMITTED" | "APPROVED" | "REJECTED", string][] = [
    [RUH.id, "DEMO-3103", "OTHER", 180, 6, "SUBMITTED", "(DEMO) غسيل وتلميع"],
    [RUH.id, "DEMO-3101", "REGISTRATION", 150, 40, "APPROVED", "(DEMO) رسوم تجديد استمارة"],
    [JED.id, "DEMO-3201", "INSURANCE", 2250, 70, "APPROVED", "(DEMO) قسط تأمين إضافي"],
    [JED.id, "DEMO-3202", "ACCIDENT", 500, 3, "SUBMITTED", "(DEMO) نسبة التحمل في الحادث"],
    [MKK.id, "DEMO-3301", "MAINTENANCE", 320, 55, "APPROVED", "(DEMO) قطع صغيرة"],
    [MKK.id, "DEMO-3302", "VIOLATION", 150, 25, "REJECTED", "(DEMO) مخالفة يتحملها السائق"],
    [MED.id, "DEMO-3401", "OTHER", 90, 12, "APPROVED", "(DEMO) رسوم مواقف"],
    [MED.id, "DEMO-3402", "MAINTENANCE", 410, 100, "APPROVED", "(DEMO) تبديل لمبات"],
    [MKK.id, "DEMO-3303", "OTHER", 75, 130, "APPROVED", "(DEMO) رسوم عبور"],
    [JED.id, "DEMO-3203", "OTHER", 260, 160, "REJECTED", "(DEMO) مصروف بدون إيصال"],
  ];
  for (const [projectId, plate, category, amount, days, status, desc] of expDefs) {
    const [e] = await tx
      .insert(expenses)
      .values({
        organizationId: orgId,
        projectId,
        vehicleId: VH(plate).id,
        category,
        amount: amount.toFixed(2),
        expenseDate: d(-days),
        description: desc,
        receiptFileId: status === "APPROVED" && days < 60 ? await pdf(`expense-receipt-${plate.toLowerCase()}.pdf`, pmOf[projectId]!) : null,
        status,
        createdBy: pmOf[projectId]!,
        reviewedBy: status === "SUBMITTED" ? null : fin.id,
        reviewedAt: status === "SUBMITTED" ? null : at(Math.max(0, days - 1), 13),
        reviewReason: status === "REJECTED" ? "(DEMO) غير مطابق للسياسة" : null,
        createdAt: at(days, 10),
      })
      .returning();
    await log("EXPENSE_CREATED", "expense", e!.id, { userId: pmOf[projectId]!, at: at(days, 10), projectId, vehicleId: VH(plate).id, newValue: { amount: e!.amount, status } });
    bump("expenses");
  }

  // ---------------------------------------------------------------- fuel: ~5 months of fill-ups
  const fuelDefs: [string, string | null, string][] = [
    ["DEMO-3101", "DEMO-E006", "2.330"],
    ["DEMO-3103", "DEMO-E007", "2.330"],
    ["DEMO-3201", "DEMO-E008", "1.660"],
    ["DEMO-3203", "DEMO-E009", "2.180"],
    ["DEMO-3301", "DEMO-E010", "1.660"],
    ["DEMO-3302", "DEMO-E011", "2.330"],
    ["DEMO-3401", "DEMO-E012", "2.330"],
    ["DEMO-3402", null, "1.660"],
  ];
  for (const [vi, [plate, drvNo, price]] of fuelDefs.entries()) {
    const veh = VH(plate);
    // Fill-ups lead up to today's odometer (older fill-ups = lower readings).
    let odo = Math.max(0, veh.currentOdometer - 4200);
    for (let i = 0; i < 7; i++) {
      odo += 480 + ((i + vi) % 3) * 90;
      const liters = (42 + ((i * 7 + vi * 3) % 18)).toFixed(2);
      await tx.insert(fuelTransactions).values({
        organizationId: orgId,
        vehicleId: veh.id,
        projectId: veh.projectId,
        driverId: drvNo ? D(drvNo) : null,
        fueledAt: at(150 - i * 22 - vi, 7 + (i % 10)),
        liters,
        pricePerLiter: price,
        total: sql`round(${liters}::numeric * ${price}::numeric, 2)`,
        odometer: odo,
        station: ["محطة تجريبية — طريق الملك فهد (DEMO)", "محطة تجريبية — الطريق الدائري (DEMO)", "محطة تجريبية — طريق المدينة (DEMO)"][i % 3],
        notes: "تعبئة تجريبية (DEMO)",
        createdBy: pmOf[veh.projectId!]!,
        createdAt: at(150 - i * 22 - vi, 18),
      });
      bump("fuelTransactions");
    }
    await tx.update(vehicles).set({ currentOdometer: sql`greatest(${vehicles.currentOdometer}, ${odo})` }).where(eq(vehicles.id, veh.id));
  }

  // ---------------------------------------------------------------- accidents: every status
  const accDefs: { key: string; plate: string; status: "OPEN" | "UNDER_REVIEW" | "INSURANCE" | "REPAIR" | "CLOSED"; days: number; severity: "MINOR" | "MODERATE" | "SEVERE" | "CRITICAL"; resp: "DRIVER" | "THIRD_PARTY" | "SHARED" | "UNKNOWN"; desc: string; lat: string; lng: string; drv?: string; mr?: string; cost?: string }[] = [
    { key: "a1", plate: "DEMO-3202", status: "UNDER_REVIEW", days: 3, severity: "MODERATE", resp: "THIRD_PARTY", desc: "(DEMO) صدمة أمامية عند إشارة مرور", lat: "21.543300", lng: "39.172800", mr: "req" },
    { key: "a2", plate: "DEMO-3402", status: "INSURANCE", days: 16, severity: "SEVERE", resp: "THIRD_PARTY", desc: "(DEMO) اصطدام جانبي — بانتظار شركة التأمين", lat: "24.524700", lng: "39.569200" },
    { key: "a3", plate: "DEMO-3403", status: "REPAIR", days: 22, severity: "MODERATE", resp: "DRIVER", desc: "(DEMO) اصطدام بعمود أثناء الاصطفاف", lat: "24.468000", lng: "39.611000", mr: "repair" },
    { key: "a4", plate: "DEMO-3302", status: "CLOSED", days: 95, severity: "MINOR", resp: "SHARED", desc: "(DEMO) خدش في الباب الخلفي", lat: "21.389100", lng: "39.857900", drv: "DEMO-E011", cost: "1200.00" },
    { key: "a5", plate: "DEMO-3101", status: "OPEN", days: 1, severity: "MINOR", resp: "UNKNOWN", desc: "(DEMO) كسر زجاج المرآة — قيد التسجيل", lat: "24.774300", lng: "46.738600", drv: "DEMO-E006" },
  ];
  const accIds: Record<string, string> = {};
  for (const a of accDefs) {
    const veh = VH(a.plate);
    const [row] = await tx
      .insert(accidents)
      .values({
        organizationId: orgId,
        vehicleId: veh.id,
        projectId: veh.projectId,
        driverId: a.drv ? D(a.drv) : null,
        occurredAt: at(a.days, 17),
        location: "موقع تجريبي (DEMO)",
        latitude: a.lat,
        longitude: a.lng,
        description: a.desc,
        severity: a.severity,
        responsibility: a.resp,
        policeReportNumber: a.status === "OPEN" ? null : `DEMO-PR-${a.plate.slice(5)}`,
        insuranceClaimNumber: a.status === "INSURANCE" || a.status === "CLOSED" ? `DEMO-CLM-${a.plate.slice(5)}` : null,
        repairCost: a.cost ?? null,
        status: a.status,
        resolution: a.status === "CLOSED" ? "(DEMO) تمت التسوية مع الطرف الآخر" : null,
        vehicleStatusBefore: a.status === "CLOSED" || a.status === "OPEN" ? null : "AVAILABLE",
        maintenanceRequestId: a.mr ? mrs[a.mr]!.id : null,
        createdBy: pmOf[veh.projectId!]!,
        closedAt: a.status === "CLOSED" ? at(a.days - 10, 12) : null,
        createdAt: at(a.days, 19),
      })
      .returning();
    accIds[a.key] = row!.id;
    await log("ACCIDENT_CREATED", "accident", row!.id, { userId: pmOf[veh.projectId!]!, at: at(a.days, 19), projectId: veh.projectId, vehicleId: veh.id, newValue: { status: "OPEN", severity: a.severity } });
    bump("accidents");
  }

  // ---------------------------------------------------------------- violations: every status
  const violDefs: [string, string, string | null, string, number, number, "OPEN" | "PAID" | "DISPUTED" | "CANCELLED", string?][] = [
    ["DEMO-V101", "DEMO-3101", "DEMO-E006", "(DEMO) تجاوز السرعة المحددة", 300, 5, "OPEN"],
    ["DEMO-V102", "DEMO-3201", "DEMO-E008", "(DEMO) قطع الإشارة", 3000, 12, "OPEN"],
    ["DEMO-V103", "DEMO-3203", "DEMO-E009", "(DEMO) وقوف في مكان ممنوع", 150, 30, "PAID"],
    ["DEMO-V104", "DEMO-3301", "DEMO-E010", "(DEMO) عدم ربط حزام الأمان", 150, 45, "PAID"],
    ["DEMO-V105", "DEMO-3302", "DEMO-E011", "(DEMO) تجاوز السرعة المحددة", 500, 20, "DISPUTED", "(DEMO) المركبة كانت في الورشة وقت المخالفة"],
    ["DEMO-V106", "DEMO-3401", "DEMO-E012", "(DEMO) مخالفة مكررة", 300, 33, "CANCELLED"],
    ["DEMO-V107", "DEMO-3103", "DEMO-E007", "(DEMO) استخدام الجوال أثناء القيادة", 500, 2, "OPEN"],
    ["DEMO-V108", "DEMO-3401", "DEMO-E013", "(DEMO) تجاوز السرعة المحددة", 300, 100, "PAID"],
  ];
  const violIds: Record<string, string> = {};
  for (const [no, plate, drvNo, type, amount, days, status, dispute] of violDefs) {
    const veh = VH(plate);
    const [row] = await tx
      .insert(violations)
      .values({
        organizationId: orgId,
        vehicleId: veh.id,
        projectId: veh.projectId,
        driverId: drvNo ? D(drvNo) : null,
        violationNumber: no,
        violationDate: d(-days),
        type,
        amount: amount.toFixed(2),
        authority: "جهة مرورية تجريبية (DEMO)",
        status,
        paymentDate: status === "PAID" ? d(-(days - 5)) : null,
        disputeReason: dispute ?? null,
        notes: status === "CANCELLED" ? "(DEMO) أُلغيت لأنها مكررة" : "مخالفة تجريبية (DEMO)",
        createdBy: pmOf[veh.projectId!]!,
        createdAt: at(days, 12),
      })
      .returning();
    violIds[no] = row!.id;
    await log("VIOLATION_CREATED", "violation", row!.id, { userId: pmOf[veh.projectId!]!, at: at(days, 12), projectId: veh.projectId, vehicleId: veh.id, newValue: { status: "OPEN", amount: row!.amount } });
    bump("violations");
  }

  // ---------------------------------------------------------------- handover sessions (real PNG photos + signature)
  const photoColors: Record<string, [number, number, number]> = { FRONT: [70, 110, 160], REAR: [90, 130, 90], LEFT: [150, 110, 70], RIGHT: [120, 90, 150], INTERIOR: [110, 110, 110], ODOMETER: [40, 60, 80], TIRES: [60, 60, 60] };
  const cats = ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES", "SIGNATURE"] as const;
  const handoverIds: Record<string, string> = {};
  const mkHandover = async (key: string, plate: string, drvNo: string, status: "RETURN_PENDING" | "RETURN_COMPLETED" | "CLOSED" | "CANCELLED", o: { created: number; handover?: number; ret?: number; uploader?: string | null }) => {
    const veh = VH(plate);
    const pm = pmOf[veh.projectId!]!;
    const hOdo = veh.currentOdometer - (o.ret !== undefined ? 2500 : 800);
    const rOdo = o.ret !== undefined ? veh.currentOdometer - 300 : null;
    const [s] = await tx
      .insert(handoverSessions)
      .values({
        organizationId: orgId,
        vehicleId: veh.id,
        driverId: D(drvNo),
        projectId: veh.projectId,
        createdBy: pm,
        // Random token that is never printed: these links are not meant to be opened.
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        status,
        // An active session keeps a valid link window; finished ones expired long ago.
        expiresAt: status === "RETURN_PENDING" ? new Date(Date.now() + config.HANDOVER_LINK_DAYS * 86_400_000) : at(o.created - 14, 23),
        accessCount: status === "CANCELLED" ? 0 : 3,
        lastAccessAt: status === "CANCELLED" ? null : at(o.ret ?? o.handover ?? o.created, 10),
        handoverAt: o.handover !== undefined ? at(o.handover, 9) : null,
        handoverOdometer: o.handover !== undefined ? hOdo : null,
        handoverNotes: o.handover !== undefined ? "(DEMO) المركبة سليمة عند الاستلام" : null,
        returnAt: o.ret !== undefined ? at(o.ret, 17) : null,
        returnOdometer: rOdo,
        returnNotes: o.ret !== undefined ? "(DEMO) خدش خفيف في الباب الأيسر" : null,
        closedAt: status === "CLOSED" ? at(o.ret! - 2, 11) : null,
        closedBy: status === "CLOSED" ? pm : null,
        reviewNotes: status === "CLOSED" ? "(DEMO) تمت المراجعة — لا توجد أضرار جوهرية" : null,
        cancelledAt: status === "CANCELLED" ? at(o.created - 1, 12) : null,
        cancelReason: status === "CANCELLED" ? "(DEMO) تم تغيير المركبة المخصصة" : null,
        createdAt: at(o.created, 8),
      })
      .returning();
    const phases: ("HANDOVER" | "RETURN")[] = [];
    if (o.handover !== undefined) phases.push("HANDOVER");
    if (o.ret !== undefined) phases.push("RETURN");
    for (const phase of phases) {
      for (const cat of cats) {
        const png = cat === "SIGNATURE" ? demoPng([255, 255, 255], true) : demoPng(photoColors[cat]!);
        const fileId = await saveFile(`demo-${plate.toLowerCase()}-${phase.toLowerCase()}-${cat.toLowerCase()}.png`, "image/png", png, o.uploader ?? null);
        const damage = phase === "RETURN" && cat === "LEFT";
        await tx.insert(handoverPhotos).values({ organizationId: orgId, sessionId: s!.id, phase, category: cat, fileId, damage, notes: damage ? "(DEMO) خدش خفيف" : "صورة تجريبية (DEMO)", capturedAt: at(phase === "HANDOVER" ? o.handover! : o.ret!, phase === "HANDOVER" ? 9 : 17) });
        bump("handoverPhotos");
      }
    }
    await log("HANDOVER_CREATED", "handover_session", s!.id, { userId: pm, at: at(o.created, 8), projectId: veh.projectId, vehicleId: veh.id, newValue: { status: "PENDING_HANDOVER" } });
    handoverIds[key] = s!.id;
    bump("handoverSessions");
  };
  await mkHandover("returnPending", "DEMO-3201", "DEMO-E008", "RETURN_PENDING", { created: 21, handover: 20, uploader: drvJedUser.id });
  await mkHandover("returnCompleted", "DEMO-3102", "DEMO-E007", "RETURN_COMPLETED", { created: 41, handover: 40, ret: 5 });
  await mkHandover("closed", "DEMO-3401", "DEMO-E013", "CLOSED", { created: 181, handover: 180, ret: 60 });
  await mkHandover("cancelled", "DEMO-3303", "DEMO-E009", "CANCELLED", { created: 12 });

  // ---------------------------------------------------------------- GPS: trips inside Saudi Arabia + latest positions
  const cities = {
    riyadh: { lat: 24.7136, lng: 46.6753 },
    jeddah: { lat: 21.5433, lng: 39.1728 },
    makkah: { lat: 21.3891, lng: 39.8579 },
    madinah: { lat: 24.5247, lng: 39.5692 },
  };
  const tripDefs: [string, string, string, keyof typeof cities][] = [
    ["DEMO-3101", "DEMO-E006", drvRuhUser.id, "riyadh"],
    ["DEMO-3201", "DEMO-E008", drvJedUser.id, "jeddah"],
    ["DEMO-3301", "DEMO-E010", drvMkkUser.id, "makkah"],
    ["DEMO-3401", "DEMO-E012", drvMedUser.id, "madinah"],
  ];
  for (const [ti, [plate, drvNo, userId, city]] of tripDefs.entries()) {
    const veh = VH(plate);
    const c = cities[city];
    let last: { lat: number; lng: number; at: Date; tripId: string } | null = null;
    for (const [k, daysAgo] of [3, 1].entries()) {
      const start = at(daysAgo, k === 0 ? 14 : 8, 10 * ti);
      const dirLat = (k === 0 ? 1 : -1) * (0.0018 + ti * 0.0002);
      const dirLng = (ti % 2 === 0 ? 1 : -1) * 0.0022;
      const pts = Array.from({ length: 16 }, (_, i) => ({
        lat: c.lat + dirLat * i + Math.sin(i / 3) * 0.0006,
        lng: c.lng + dirLng * i + Math.cos(i / 4) * 0.0005,
        at: new Date(start.getTime() + i * 4 * 60_000),
      }));
      let dist = 0;
      for (let i = 1; i < pts.length; i++) dist += haversineMeters(pts[i - 1]!.lat, pts[i - 1]!.lng, pts[i]!.lat, pts[i]!.lng);
      const [trip] = await tx
        .insert(trips)
        .values({ organizationId: orgId, driverId: D(drvNo), vehicleId: veh.id, projectId: veh.projectId, userId, source: "WEB", status: "ENDED", startedAt: start, endedAt: pts[pts.length - 1]!.at, distanceMeters: dist.toFixed(1), pointCount: pts.length, lastPointAt: pts[pts.length - 1]!.at })
        .returning();
      await tx.insert(locationPings).values(
        pts.map((p, i) => ({ organizationId: orgId, tripId: trip!.id, driverId: D(drvNo), vehicleId: veh.id, projectId: veh.projectId, latitude: p.lat.toFixed(6), longitude: p.lng.toFixed(6), accuracy: "10.00", speed: (8 + (i % 5) * 2.5).toFixed(2), heading: ((90 + i * 7) % 360).toFixed(2), recordedAt: p.at, receivedAt: p.at })),
      );
      bump("trips");
      bump("locationPings", pts.length);
      const lp = pts[pts.length - 1]!;
      last = { lat: lp.lat, lng: lp.lng, at: lp.at, tripId: trip!.id };
    }
    await tx.insert(vehicleLocations).values({ vehicleId: veh.id, organizationId: orgId, driverId: D(drvNo), tripId: last!.tripId, latitude: last!.lat.toFixed(6), longitude: last!.lng.toFixed(6), accuracy: "10.00", recordedAt: last!.at }).onConflictDoNothing();
    bump("vehicleLocations");
  }
  const parked: [string, string, number, number][] = [
    ["DEMO-3103", "DEMO-E007", 24.6877, 46.7219],
    ["DEMO-3203", "DEMO-E009", 21.4858, 39.1925],
    ["DEMO-3302", "DEMO-E011", 21.4225, 39.8262],
  ];
  for (const [plate, drvNo, lat, lng] of parked) {
    await tx.insert(vehicleLocations).values({ vehicleId: VH(plate).id, organizationId: orgId, driverId: D(drvNo), tripId: null, latitude: lat.toFixed(6), longitude: lng.toFixed(6), accuracy: "15.00", recordedAt: at(0, 7) }).onConflictDoNothing();
    bump("vehicleLocations");
  }

  // ---------------------------------------------------------------- assignments of every type
  const asg = async (o: { type: (typeof assignments.$inferInsert)["type"]; to: string; by: string; project?: string | null; plate?: string; ref?: string | null; title: string; priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; status?: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"; due?: number; created: number }) => {
    const status = o.status ?? "PENDING";
    const [a] = await tx
      .insert(assignments)
      .values({
        organizationId: orgId,
        type: o.type,
        assignedTo: o.to,
        assignedBy: o.by,
        projectId: o.project ?? null,
        vehicleId: o.plate ? VH(o.plate).id : null,
        referenceId: o.ref ?? null,
        title: o.title,
        description: "مهمة تجريبية (DEMO)",
        priority: o.priority ?? "MEDIUM",
        status,
        dueDate: o.due === undefined ? null : d(o.due),
        createdAt: at(o.created, 9),
        completedAt: status === "COMPLETED" ? at(Math.max(0, o.created - 2), 15) : null,
      })
      .returning();
    await log("ASSIGNMENT_CREATED", "assignment", a!.id, { userId: o.by, at: at(o.created, 9), projectId: o.project ?? null, vehicleId: o.plate ? VH(o.plate).id : null, newValue: { type: o.type, status } });
    bump("assignments");
  };
  await asg({ type: "INVOICE", to: fin.id, by: pmMed.id, project: MED.id, plate: "DEMO-3403", ref: invoiceIds["DEMO-INV-103"], title: "(DEMO) مراجعة الفاتورة DEMO-INV-103", priority: "HIGH", status: "IN_PROGRESS", due: 3, created: 6 });
  await asg({ type: "INVOICE", to: fin.id, by: pmMkk.id, project: MKK.id, plate: "DEMO-3302", ref: invoiceIds["DEMO-INV-102"], title: "(DEMO) مراجعة الفاتورة DEMO-INV-102", due: 5, created: 4 });
  await asg({ type: "INVOICE", to: fin.id, by: pm2.id, project: JED.id, plate: "DEMO-3203", ref: invoiceIds["DEMO-INV-105"], title: "(DEMO) تحويل مبلغ الفاتورة DEMO-INV-105", priority: "URGENT", due: -1, created: 5 });
  await asg({ type: "VEHICLE", to: pmMkk.id, by: admin.id, project: MKK.id, plate: "DEMO-3302", ref: VH("DEMO-3302").id, title: "(DEMO) متابعة حالة المركبة DEMO-3302", status: "IN_PROGRESS", due: 7, created: 10 });
  await asg({ type: "VEHICLE", to: drvRuhUser.id, by: pm1.id, project: RUH.id, plate: "DEMO-3101", ref: VH("DEMO-3101").id, title: "(DEMO) استلام المركبة DEMO-3101", status: "COMPLETED", created: 160 });
  await asg({ type: "REGISTRATION", to: basicUser.id, by: pm1.id, project: RUH.id, plate: "DEMO-1002", ref: VH("DEMO-1002").id, title: "(DEMO) تجديد استمارة المركبة DEMO-1002", priority: "HIGH", due: 7, created: 3 });
  await asg({ type: "INSURANCE", to: pm2.id, by: admin.id, project: JED.id, plate: "DEMO-2001", ref: VH("DEMO-2001").id, title: "(DEMO) تجديد تأمين المركبة DEMO-2001 (منتهي)", priority: "URGENT", due: -2, created: 8 });
  await asg({ type: "DOCUMENT", to: pmMed.id, by: admin.id, project: MED.id, plate: "DEMO-3402", ref: VH("DEMO-3402").id, title: "(DEMO) تحديث الفحص الدوري للمركبة DEMO-3402", due: 10, created: 2 });
  await asg({ type: "DOCUMENT", to: basicUser.id, by: pm2.id, project: JED.id, title: "(DEMO) رفع صور إقامات سائقي جدة", status: "IN_PROGRESS", due: 4, created: 5 });
  await asg({ type: "ACCIDENT", to: tech.id, by: pm2.id, project: JED.id, plate: "DEMO-3202", ref: accIds.a1, title: "(DEMO) تقييم أضرار حادث المركبة DEMO-3202", priority: "HIGH", status: "IN_PROGRESS", due: 2, created: 3 });
  await asg({ type: "ACCIDENT", to: pmMed.id, by: admin.id, project: MED.id, plate: "DEMO-3402", ref: accIds.a2, title: "(DEMO) متابعة مطالبة التأمين للمركبة DEMO-3402", due: 14, created: 15 });
  await asg({ type: "VIOLATION", to: pmMkk.id, by: admin.id, project: MKK.id, plate: "DEMO-3302", ref: violIds["DEMO-V105"], title: "(DEMO) متابعة الاعتراض على المخالفة DEMO-V105", status: "IN_PROGRESS", due: 9, created: 19 });
  await asg({ type: "VIOLATION", to: pm1.id, by: admin.id, project: RUH.id, plate: "DEMO-3101", ref: violIds["DEMO-V101"], title: "(DEMO) سداد المخالفة DEMO-V101", due: 20, created: 4 });
  await asg({ type: "TASK", to: tech.id, by: pmMed.id, project: MED.id, title: "(DEMO) فحص شامل لأسطول المدينة", status: "COMPLETED", created: 12 });
  await asg({ type: "TASK", to: basicUser.id, by: pm2.id, project: JED.id, title: "(DEMO) تحديث قراءات عدادات مركبات جدة", priority: "LOW", due: 6, created: 1 });
  await asg({ type: "PROJECT", to: pmMed.id, by: admin.id, project: MED.id, ref: MED.id, title: "(DEMO) إطلاق مشروع المدينة", status: "COMPLETED", created: 240 });
  await asg({ type: "TASK", to: viewer.id, by: admin.id, project: RUH.id, title: "(DEMO) مراجعة تقرير الأسطول الشهري", status: "CANCELLED", created: 30 });

  // ---------------------------------------------------------------- notifications
  type Cat = (typeof notifications.$inferInsert)["category"];
  const notes: { to: string; type: string; cat: Cat; title: string; link?: string; project?: string | null; days: number; read?: boolean }[] = [
    { to: admin.id, type: "SYSTEM_BROADCAST", cat: "SYSTEM", title: `(تجريبي) تم تجهيز بيانات ${DEMO_ORG_NAME}`, days: 0 },
    { to: admin.id, type: "DOCUMENT_EXPIRING", cat: "DOCUMENT_EXPIRY", title: "(تجريبي) مستندات مركبات تنتهي خلال 30 يومًا", link: "/documents", days: 0 },
    { to: admin.id, type: "ACCIDENT_REPORTED", cat: "ACCIDENT", title: "(تجريبي) تم تسجيل حادث للمركبة DEMO-3202", link: `/accidents/${accIds.a1}`, project: JED.id, days: 3 },
    { to: pm1.id, type: "MAINTENANCE_STATUS", cat: "MAINTENANCE", title: "(تجريبي) تم قبول تسليم صيانة المركبة DEMO-3101", link: `/maintenance/${mrs.accepted!.id}`, project: RUH.id, days: 3 },
    { to: pm1.id, type: "VIOLATION_CREATED", cat: "VIOLATION", title: "(تجريبي) مخالفة جديدة DEMO-V107", link: `/violations/${violIds["DEMO-V107"]}`, project: RUH.id, days: 2 },
    { to: pm2.id, type: "INVOICE_REJECTED", cat: "FINANCE", title: "(تجريبي) تم رفض الفاتورة DEMO-INV-109", link: `/finance/invoices/${invoiceIds["DEMO-INV-109"]}`, project: JED.id, days: 12, read: true },
    { to: pm2.id, type: "HANDOVER_COMPLETED", cat: "HANDOVER", title: "(تجريبي) استلم السائق المركبة DEMO-3201", link: `/handovers/${handoverIds.returnPending}`, project: JED.id, days: 20, read: true },
    { to: pmMkk.id, type: "QUOTE_SUBMITTED", cat: "MAINTENANCE", title: "(تجريبي) عرض سعر بانتظار الاعتماد للمركبة DEMO-3302", link: `/maintenance/${mrs.pending!.id}`, project: MKK.id, days: 8 },
    { to: pmMed.id, type: "ACCIDENT_REPORTED", cat: "ACCIDENT", title: "(تجريبي) حادث المركبة DEMO-3402 محال للتأمين", link: `/accidents/${accIds.a2}`, project: MED.id, days: 15 },
    { to: pmMed.id, type: "HANDOVER_RETURNED", cat: "HANDOVER", title: "(تجريبي) تم إغلاق جلسة استلام المركبة DEMO-3401", link: `/handovers/${handoverIds.closed}`, project: MED.id, days: 58, read: true },
    { to: fin.id, type: "INVOICE_SUBMITTED", cat: "FINANCE", title: "(تجريبي) فاتورة جديدة بانتظار المراجعة DEMO-INV-102", link: `/finance/invoices/${invoiceIds["DEMO-INV-102"]}`, project: MKK.id, days: 4 },
    { to: fin.id, type: "INVOICE_OVERDUE", cat: "FINANCE", title: "(تجريبي) فاتورة متأخرة بانتظار التحويل DEMO-INV-105", link: `/finance/invoices/${invoiceIds["DEMO-INV-105"]}`, project: JED.id, days: 0 },
    { to: tech.id, type: "ASSIGNMENT_CREATED", cat: "ASSIGNMENT", title: "(تجريبي) أسندت إليك مهمة تقييم أضرار حادث", link: "/my-assignments", project: JED.id, days: 3 },
    { to: tech.id, type: "MAINTENANCE_ASSIGNED", cat: "MAINTENANCE", title: "(تجريبي) أسند إليك طلب صيانة المركبة DEMO-3303", link: `/maintenance/${mrs.insp!.id}`, project: MKK.id, days: 5, read: true },
    { to: driverUser.id, type: "HANDOVER_LINK", cat: "HANDOVER", title: "(تجريبي) مطلوب منك استلام المركبة DEMO-1001", link: "/handovers", days: 1 },
    { to: drvRuhUser.id, type: "VIOLATION_CREATED", cat: "VIOLATION", title: "(تجريبي) سُجلت مخالفة على مركبتك DEMO-3101", link: `/violations/${violIds["DEMO-V101"]}`, days: 5 },
    { to: drvJedUser.id, type: "HANDOVER_COMPLETED", cat: "HANDOVER", title: "(تجريبي) تم تأكيد استلامك للمركبة DEMO-3201", link: `/handovers/${handoverIds.returnPending}`, days: 20, read: true },
    { to: basicUser.id, type: "ASSIGNMENT_CREATED", cat: "ASSIGNMENT", title: "(تجريبي) مهمة جديدة: تجديد استمارة DEMO-1002", link: "/my-assignments", project: RUH.id, days: 3 },
    { to: viewer.id, type: "SYSTEM_BROADCAST", cat: "SYSTEM", title: "(تجريبي) مرحبًا بك — صلاحية عرض فقط", days: 1 },
  ];
  for (const [i, n] of notes.entries()) {
    await tx
      .insert(notifications)
      .values({ organizationId: orgId, userId: n.to, type: n.type, category: n.cat, dedupeKey: `demo-seed:${i}`, title: n.title, body: "إشعار تجريبي (DEMO)", link: n.link ?? null, projectId: n.project ?? null, readAt: n.read ? at(Math.max(0, n.days - 1), 12) : null, createdAt: at(n.days, 8 + (i % 8)) })
      .onConflictDoNothing();
    bump("notifications");
  }

  return counts;
}
