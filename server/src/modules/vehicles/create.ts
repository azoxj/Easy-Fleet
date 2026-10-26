import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { z } from "zod";
import { assertCanUseProject, type Access } from "../../auth/access.js";
import type { DbOrTx } from "../../db/client.js";
import { projects, vehicles } from "../../db/schema/index.js";
import { badRequest, forbidden } from "../../http/errors.js";
import { isoDate, money, optionalText, trimmed, uuid } from "../../http/validate.js";
import { audit } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { tr } from "../../i18n/index.js";

/** Statuses a user may set by hand. The rest are driven by workflows (maintenance, handover, accidents). */
export const MANUAL_STATUSES = ["AVAILABLE", "OUT_OF_SERVICE", "SOLD"] as const;

const thisYear = new Date().getFullYear();

export const VehicleBody = z.object({
  plateNumber: trimmed(2, 20),
  /** Arabic plate as printed, e.g. "أ ب ج 1234". */
  plateArabic: z.string().trim().max(20).regex(/^[\u0600-\u06FF0-9\u0660-\u0669 ]+$/, "اللوحة العربية: حروف عربية وأرقام فقط").nullable().optional().or(z.literal("").transform(() => null)),
  plateEnglish: z.string().trim().toUpperCase().max(20).regex(/^[A-Z0-9 ]+$/, "اللوحة الإنجليزية: حروف إنجليزية وأرقام فقط").nullable().optional().or(z.literal("").transform(() => null)),
  /** Istimara serial / sequence number. */
  serialNumber: z.string().trim().max(30).regex(/^[0-9A-Za-z-]+$/, "الرقم التسلسلي غير صالح").nullable().optional().or(z.literal("").transform(() => null)),
  vehicleNumber: optionalText(30),
  make: trimmed(1, 60),
  model: trimmed(1, 60),
  year: z.coerce.number().int().min(1980).max(thisYear + 1).nullable().optional(),
  color: optionalText(30),
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, "رقم الهيكل (VIN) يجب أن يكون 17 خانة")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  currentOdometer: z.coerce.number().int().min(0).max(5_000_000).optional(),
  status: z.enum(MANUAL_STATUSES).optional(),
  projectId: uuid.nullable().optional(),
  purchaseDate: isoDate.nullable().optional(),
  purchasePrice: money.nullable().optional(),
  warrantyStart: isoDate.nullable().optional(),
  warrantyEnd: isoDate.nullable().optional(),
  notes: optionalText(2000),
  // service schedule (maintenance / oil change reminders)
  nextServiceDate: isoDate.nullable().optional(),
  nextServiceOdometer: z.coerce.number().int().min(0).max(5_000_000).nullable().optional(),
  nextOilChangeDate: isoDate.nullable().optional(),
  nextOilChangeOdometer: z.coerce.number().int().min(0).max(5_000_000).nullable().optional(),
});

export function checkWarranty(b: { warrantyStart?: string | null; warrantyEnd?: string | null }) {
  if (b.warrantyStart && b.warrantyEnd && b.warrantyEnd < b.warrantyStart) {
    throw badRequest(tr("نهاية الضمان يجب أن تكون بعد بدايته"));
  }
}

/**
 * The project rule of "create a vehicle": a target project needs vehicles.create on it (membership for PROJECT scope);
 * without a project only an ALL-scope holder may create. Shared by POST /vehicles and the bulk import.
 */
export async function authorizeVehicleTarget(db: DbOrTx, access: Access, projectId: string | null | undefined) {
  if (projectId) await assertCanUseProject(db, access, projectId, "vehicles.create");
  else if (access.require("vehicles.create") !== "ALL") throw forbidden(tr("يجب اختيار مشروع من مشاريعك"));
}

export type VehicleInput = z.infer<typeof VehicleBody>;

/** Inserts one vehicle with its audit record and the project-manager notification (inside the caller's transaction). */
export async function insertVehicle(tx: DbOrTx, req: Request, access: Access, body: VehicleInput) {
  const [v] = await tx
    .insert(vehicles)
    .values({
      organizationId: access.orgId,
      plateNumber: body.plateNumber,
      plateArabic: body.plateArabic ?? null,
      plateEnglish: body.plateEnglish ?? null,
      serialNumber: body.serialNumber ?? null,
      vehicleNumber: body.vehicleNumber ?? null,
      make: body.make,
      model: body.model,
      year: body.year ?? null,
      color: body.color ?? null,
      vin: body.vin ?? null,
      currentOdometer: body.currentOdometer ?? 0,
      status: body.status ?? "AVAILABLE",
      projectId: body.projectId ?? null,
      purchaseDate: body.purchaseDate ?? null,
      purchasePrice: body.purchasePrice ?? null,
      warrantyStart: body.warrantyStart ?? null,
      warrantyEnd: body.warrantyEnd ?? null,
      notes: body.notes ?? null,
      nextServiceDate: body.nextServiceDate ?? null,
      nextServiceOdometer: body.nextServiceOdometer ?? null,
      nextOilChangeDate: body.nextOilChangeDate ?? null,
      nextOilChangeOdometer: body.nextOilChangeOdometer ?? null,
      createdBy: access.userId,
    })
    .returning();
  await audit(tx, req, {
    action: "VEHICLE_CREATED",
    entity: "vehicle",
    entityId: v!.id,
    projectId: v!.projectId,
    vehicleId: v!.id,
    metadata: { plateNumber: v!.plateNumber, projectId: v!.projectId },
  });
  if (v!.projectId) await notifyProjectManager(tx, access, v!.projectId, v!.id, `تمت إضافة المركبة ${v!.plateNumber} إلى مشروعك`);
  return v!;
}

export async function notifyProjectManager(tx: Parameters<typeof notifyUsers>[0], access: Access, projectId: string, vehicleId: string, title: string) {
  const [p] = await tx
    .select({ managerId: projects.managerId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, access.orgId)));
  if (!p?.managerId || p.managerId === access.userId) return;
  await notifyUsers(tx, {
    orgId: access.orgId,
    userIds: [p.managerId],
    type: "VEHICLE_ADDED_TO_PROJECT",
    title,
    link: `/vehicles/${vehicleId}`,
    entityType: "vehicle",
    entityId: vehicleId,
    projectId,
  });
}
