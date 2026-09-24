import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { driverIsUser, getVehicleInScope, permissionHolders, recordScope, type Access } from "../../auth/access.js";
import { config } from "../../config.js";
import { db, type DbOrTx } from "../../db/client.js";
import { drivers, employees, handoverPhotoCategory, handoverPhotos, handoverSessions, handoverStatus, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { now } from "../../lib/clock.js";
import { PgRateLimiter, pgRateLimit, uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { eligibleDriver, setVehicleDriver } from "../vehicles/driver-service.js";
import { driverNameSql, rawUpload, recordTimeline } from "./common.js";

/** Authenticated management + driver self-service. */
export const handoverRouter = Router();
/** Token-based public API for the mobile link (mounted before requireAuth). */
export const publicHandoverRouter = Router();

type Session = typeof handoverSessions.$inferSelect;
type Phase = "HANDOVER" | "RETURN";
type Category = (typeof handoverPhotoCategory.enumValues)[number];

/** The seven mandatory photos for each phase (plus the driver's signature). */
export const REQUIRED_PHOTOS: Category[] = ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES"];
const ACTIVE: Session["status"][] = ["PENDING_HANDOVER", "RETURN_PENDING"];
/** Vehicles in these statuses cannot be handed over. */
const BLOCKED_VEHICLE = new Set(["IN_MAINTENANCE", "ACCIDENT", "OUT_OF_SERVICE", "SOLD", "ARCHIVED"]);

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const linkFor = (token: string) => `${config.publicAppUrl}/h/${token}`;
const phaseOf = (s: Session): Phase | null => (s.status === "PENDING_HANDOVER" ? "HANDOVER" : s.status === "RETURN_PENDING" ? "RETURN" : null);

export function handoverScope(a: Access, perm: "handover.read" | "handover.manage" = "handover.read"): SQL {
  return recordScope(a, perm, {
    orgCol: handoverSessions.organizationId,
    projectCol: handoverSessions.projectId,
    assigned: sql`(${driverIsUser(a, handoverSessions.driverId)} or ${handoverSessions.createdBy} = ${a.userId})`,
  });
}

async function loadSession(a: Access, id: string, perm: "handover.read" | "handover.manage" = "handover.read") {
  const [s] = await db.select().from(handoverSessions).where(and(eq(handoverSessions.id, id), handoverScope(a, perm))).limit(1);
  if (!s) throw notFound("جلسة التسليم غير موجودة");
  return s;
}

async function driverUserId(tx: DbOrTx, driverId: string) {
  const [d] = await tx.select({ userId: employees.userId }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(drivers.id, driverId));
  return d?.userId ?? null;
}

async function managersOf(tx: DbOrTx, s: Session) {
  const ids = new Set(await permissionHolders(tx, s.organizationId, "handover.manage", s.projectId, { includeAllScope: false }));
  ids.add(s.createdBy);
  return [...ids];
}

// ---------------------------------------------------------------- shared views

async function photosOf(sessionId: string) {
  return db
    .select({ id: handoverPhotos.id, phase: handoverPhotos.phase, category: handoverPhotos.category, damage: handoverPhotos.damage, notes: handoverPhotos.notes, latitude: handoverPhotos.latitude, longitude: handoverPhotos.longitude, accuracy: handoverPhotos.accuracy, capturedAt: handoverPhotos.capturedAt, createdAt: handoverPhotos.createdAt })
    .from(handoverPhotos)
    .where(eq(handoverPhotos.sessionId, sessionId))
    .orderBy(handoverPhotos.createdAt);
}

type PhotoRow = Awaited<ReturnType<typeof photosOf>>[number];

/** Handover vs return: per-slot photos and damage flags, odometer delta, notes. */
export function compare(s: Session, photos: PhotoRow[]) {
  const pick = (phase: Phase, c: Category) => photos.find((p) => p.phase === phase && p.category === c) ?? null;
  const slots = [...REQUIRED_PHOTOS, "SIGNATURE" as const].map((c) => {
    const h = pick("HANDOVER", c);
    const r = pick("RETURN", c);
    return {
      category: c,
      handover: h ? { id: h.id, damage: h.damage, notes: h.notes } : null,
      return: r ? { id: r.id, damage: r.damage, notes: r.notes } : null,
      newDamage: !!r?.damage && !h?.damage,
    };
  });
  const extras = photos.filter((p) => p.category === "OTHER").map((p) => ({ id: p.id, phase: p.phase, damage: p.damage, notes: p.notes }));
  return {
    odometer: {
      handover: s.handoverOdometer,
      return: s.returnOdometer,
      distance: s.handoverOdometer != null && s.returnOdometer != null ? s.returnOdometer - s.handoverOdometer : null,
    },
    notes: { handover: s.handoverNotes, return: s.returnNotes },
    slots,
    extras,
    newDamageCount: slots.filter((x) => x.newDamage).length + extras.filter((e) => e.phase === "RETURN" && e.damage).length,
    durationHours: s.handoverAt && s.returnAt ? Math.round(((s.returnAt.getTime() - s.handoverAt.getTime()) / 3_600_000) * 10) / 10 : null,
  };
}

function progress(s: Session, photos: PhotoRow[]) {
  const phase = phaseOf(s);
  if (!phase) return null;
  const have = new Set(photos.filter((p) => p.phase === phase).map((p) => p.category));
  return {
    phase,
    required: REQUIRED_PHOTOS,
    uploaded: [...have],
    missing: [...REQUIRED_PHOTOS, "SIGNATURE" as Category].filter((c) => !have.has(c)),
  };
}

// ---------------------------------------------------------------- core operations (shared by link + driver login)

const PhotoQuery = z.object({
  damage: z.enum(["true", "false"]).optional(),
  notes: z.string().trim().max(500).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracy: z.coerce.number().min(0).max(100_000).optional(),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
});

async function uploadPhoto(req: Request, s: Session, category: Category, actorUserId: string | null) {
  const phase = phaseOf(s);
  if (!phase) throw new HttpError(409, "INVALID_TRANSITION", "الجلسة لا تقبل صورًا في حالتها الحالية");
  const q = PhotoQuery.parse(req.query);
  if ((q.lat == null) !== (q.lng == null)) throw badRequest("يجب إرسال خط العرض وخط الطول معًا");
  return db.transaction(async (tx) => {
    const f = await storeUpload(tx, req, s.organizationId, actorUserId, { imagesOnly: true });
    if (category !== "OTHER") {
      await tx.delete(handoverPhotos).where(and(eq(handoverPhotos.sessionId, s.id), eq(handoverPhotos.phase, phase), eq(handoverPhotos.category, category)));
    } else {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(handoverPhotos).where(and(eq(handoverPhotos.sessionId, s.id), eq(handoverPhotos.phase, phase), eq(handoverPhotos.category, "OTHER")));
      if (n >= 10) throw badRequest("الحد الأقصى 10 صور إضافية لكل مرحلة");
    }
    const [p] = await tx
      .insert(handoverPhotos)
      .values({
        organizationId: s.organizationId,
        sessionId: s.id,
        phase,
        category,
        fileId: f.id,
        damage: q.damage === "true",
        notes: q.notes || null,
        latitude: q.lat != null ? q.lat.toFixed(6) : null,
        longitude: q.lng != null ? q.lng.toFixed(6) : null,
        accuracy: q.accuracy != null ? q.accuracy.toFixed(2) : null,
        capturedAt: q.capturedAt ? new Date(q.capturedAt) : null,
      })
      .returning();
    await audit(tx, req, { action: "HANDOVER_PHOTO_UPLOADED", entity: "handover", entityId: s.id, projectId: s.projectId, vehicleId: s.vehicleId, orgId: s.organizationId, userId: actorUserId, metadata: { phase, category, damage: p!.damage } });
    return { id: p!.id, phase, category, damage: p!.damage };
  });
}

const SubmitBody = z
  .object({
    odometer: z.coerce.number().int().min(0).max(10_000_000),
    notes: optionalText(2000),
    confirm: z.literal(true, { message: "يجب تأكيد صحة البيانات" }),
  })
  .strict();

async function submitPhase(req: Request, s: Session, actorUserId: string | null) {
  const phase = phaseOf(s);
  if (!phase) throw new HttpError(409, "INVALID_TRANSITION", "تم إكمال هذه المرحلة مسبقًا");
  const b = SubmitBody.parse(req.body);
  const photos = await photosOf(s.id);
  const missing = progress(s, photos)!.missing;
  if (missing.length) throw badRequest(`الصور التالية مطلوبة قبل الإرسال: ${missing.join(", ")}`, { missing });
  return db.transaction(async (tx) => {
    const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, s.vehicleId)).for("update");
    if (!v) throw notFound("المركبة غير موجودة");
    const actor = { orgId: s.organizationId, userId: actorUserId };
    if (phase === "HANDOVER") {
      if (b.odometer < v.currentOdometer) throw badRequest(`قراءة العداد أقل من القراءة المسجلة للمركبة (${v.currentOdometer})`);
      if (BLOCKED_VEHICLE.has(v.status)) throw new HttpError(409, "INVALID_TRANSITION", "حالة المركبة لا تسمح بالتسليم حاليًا");
      const [u] = await tx
        .update(handoverSessions)
        .set({ status: "RETURN_PENDING", handoverAt: now(), handoverOdometer: b.odometer, handoverNotes: b.notes ?? null, updatedAt: new Date() })
        .where(and(eq(handoverSessions.id, s.id), eq(handoverSessions.status, "PENDING_HANDOVER")))
        .returning();
      if (!u) throw new HttpError(409, "INVALID_TRANSITION", "تم تحديث الجلسة، أعد تحميل الصفحة");
      if (b.odometer > v.currentOdometer) await tx.update(vehicles).set({ currentOdometer: b.odometer, updatedAt: new Date() }).where(eq(vehicles.id, v.id));
      const fresh = { ...v, currentOdometer: Math.max(v.currentOdometer, b.odometer) };
      if (v.assignedDriverId !== s.driverId) {
        const [d] = await tx.select({ id: drivers.id, userId: employees.userId, fullName: employees.fullName }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(drivers.id, s.driverId));
        await setVehicleDriver(tx, req, actor, fresh, d!, "handover");
      }
      await audit(tx, req, { action: "HANDOVER_COMPLETED", entity: "handover", entityId: s.id, projectId: s.projectId, vehicleId: s.vehicleId, orgId: s.organizationId, userId: actorUserId, metadata: { odometer: b.odometer, fromStatus: "PENDING_HANDOVER", toStatus: "RETURN_PENDING" } });
      await notifyUsers(tx, { orgId: s.organizationId, userIds: (await managersOf(tx, s)).filter((x) => x !== actorUserId), type: "HANDOVER_COMPLETED", title: `تم استلام المركبة ${v.plateNumber} من السائق`, link: `/handovers/${s.id}`, entityType: "handover", entityId: s.id, projectId: s.projectId });
      return u;
    }
    if (s.handoverOdometer != null && b.odometer < s.handoverOdometer) throw badRequest(`قراءة العداد أقل من قراءة التسليم (${s.handoverOdometer})`);
    const [u] = await tx
      .update(handoverSessions)
      .set({ status: "RETURN_COMPLETED", returnAt: now(), returnOdometer: b.odometer, returnNotes: b.notes ?? null, updatedAt: new Date() })
      .where(and(eq(handoverSessions.id, s.id), eq(handoverSessions.status, "RETURN_PENDING")))
      .returning();
    if (!u) throw new HttpError(409, "INVALID_TRANSITION", "تم تحديث الجلسة، أعد تحميل الصفحة");
    if (b.odometer > v.currentOdometer) await tx.update(vehicles).set({ currentOdometer: b.odometer, updatedAt: new Date() }).where(eq(vehicles.id, v.id));
    if (v.assignedDriverId === s.driverId) await setVehicleDriver(tx, req, actor, { ...v, currentOdometer: Math.max(v.currentOdometer, b.odometer) }, null, "return");
    const cmp = compare(u, await photosOf(s.id));
    await audit(tx, req, { action: "HANDOVER_RETURN_COMPLETED", entity: "handover", entityId: s.id, projectId: s.projectId, vehicleId: s.vehicleId, orgId: s.organizationId, userId: actorUserId, metadata: { odometer: b.odometer, distance: cmp.odometer.distance, newDamage: cmp.newDamageCount, fromStatus: "RETURN_PENDING", toStatus: "RETURN_COMPLETED" } });
    await notifyUsers(tx, {
      orgId: s.organizationId,
      userIds: (await managersOf(tx, s)).filter((x) => x !== actorUserId),
      type: "HANDOVER_RETURNED",
      title: `تمت إعادة المركبة ${v.plateNumber}${cmp.newDamageCount ? ` — ${cmp.newDamageCount} ملاحظة ضرر جديدة` : ""}`,
      link: `/handovers/${s.id}`,
      entityType: "handover",
      entityId: s.id,
      projectId: s.projectId,
    });
    return u;
  });
}

// ---------------------------------------------------------------- authenticated management

const listColumns = {
  id: handoverSessions.id,
  vehicleId: handoverSessions.vehicleId,
  plateNumber: vehicles.plateNumber,
  driverId: handoverSessions.driverId,
  driverName: driverNameSql(handoverSessions.driverId),
  projectId: handoverSessions.projectId,
  projectName: projects.name,
  status: handoverSessions.status,
  expiresAt: handoverSessions.expiresAt,
  handoverAt: handoverSessions.handoverAt,
  returnAt: handoverSessions.returnAt,
  handoverOdometer: handoverSessions.handoverOdometer,
  returnOdometer: handoverSessions.returnOdometer,
  createdByName: users.name,
  createdAt: handoverSessions.createdAt,
};

const ListQuery = pagination.extend({
  status: z.enum(handoverStatus.enumValues).optional(),
  active: z.enum(["true", "false"]).optional(),
  vehicleId: uuid.optional(),
  driverId: uuid.optional(),
  projectId: uuid.optional(),
  mine: z.enum(["true", "false"]).optional(),
});

handoverRouter.get("/handovers", requirePermission("handover.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where: SQL[] = [handoverScope(access)];
  if (q.status) where.push(eq(handoverSessions.status, q.status));
  if (q.active === "true") where.push(inArray(handoverSessions.status, ACTIVE));
  if (q.vehicleId) where.push(eq(handoverSessions.vehicleId, q.vehicleId));
  if (q.driverId) where.push(eq(handoverSessions.driverId, q.driverId));
  if (q.projectId) where.push(eq(handoverSessions.projectId, q.projectId));
  if (q.mine === "true") where.push(driverIsUser(access, handoverSessions.driverId));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db.select(listColumns).from(handoverSessions).innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId)).leftJoin(projects, eq(projects.id, handoverSessions.projectId)).innerJoin(users, eq(users.id, handoverSessions.createdBy)).where(cond).orderBy(desc(handoverSessions.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(handoverSessions).where(cond),
  ]);
  const t = now().getTime();
  res.json(paged(rows.map((r) => ({ ...r, expired: ACTIVE.includes(r.status) && r.expiresAt.getTime() < t })), count?.n ?? 0, q.page, q.pageSize));
});

function actionsFor(a: Access, s: Session, isDriver: boolean) {
  const out: string[] = [];
  const m = a.scopeOf("handover.manage");
  const canManage = m === "ALL" || (m === "PROJECT" && a.isMemberOf(s.projectId));
  if (canManage && ACTIVE.includes(s.status)) out.push("rotateLink");
  if (canManage && s.status === "PENDING_HANDOVER") out.push("cancel");
  if (canManage && s.status === "RETURN_COMPLETED") out.push("close");
  if (isDriver && ACTIVE.includes(s.status) && s.expiresAt.getTime() > now().getTime()) out.push("perform");
  return out;
}

handoverRouter.get("/handovers/:id", requirePermission("handover.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const s = await loadSession(access, id);
  const [[extra], photos, timeline, du] = await Promise.all([
    db
      .select({ plateNumber: vehicles.plateNumber, make: vehicles.make, model: vehicles.model, vehicleStatus: vehicles.status, currentOdometer: vehicles.currentOdometer, projectName: projects.name, driverName: driverNameSql(handoverSessions.driverId), createdByName: users.name })
      .from(handoverSessions)
      .innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId))
      .leftJoin(projects, eq(projects.id, handoverSessions.projectId))
      .innerJoin(users, eq(users.id, handoverSessions.createdBy))
      .where(eq(handoverSessions.id, id)),
    photosOf(id),
    recordTimeline(access.orgId, "handover", id),
    driverUserId(db, s.driverId),
  ]);
  const { tokenHash: _t, ...safe } = s;
  res.json({
    data: {
      ...safe,
      ...extra,
      expired: ACTIVE.includes(s.status) && s.expiresAt.getTime() < now().getTime(),
      photos,
      progress: progress(s, photos),
      comparison: compare(s, photos),
      timeline,
      actions: actionsFor(access, s, du === access.userId),
    },
  });
});

const CreateBody = z
  .object({
    vehicleId: uuid,
    driverId: uuid,
    expiresInDays: z.coerce.number().int().min(1).max(90).optional(),
  })
  .strict();

handoverRouter.post("/handovers", requirePermission("handover.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = CreateBody.parse(req.body);
  const v = await getVehicleInScope(db, access, b.vehicleId, "handover.create");
  const scope = access.require("handover.create");
  if (scope === "ASSIGNED" || (scope === "PROJECT" && !access.isMemberOf(v.projectId))) throw forbidden();
  if (BLOCKED_VEHICLE.has(v.status)) throw badRequest("حالة المركبة لا تسمح بالتسليم (صيانة/حادث/خارج الخدمة/مؤرشفة)");
  if (v.assignedDriverId && v.assignedDriverId !== b.driverId) throw badRequest("المركبة مسندة لسائق آخر؛ أنهِ الإسناد الحالي أولًا");
  const d = await eligibleDriver(db, access, v, b.driverId, { allowCurrentHolding: true });
  const token = newToken();
  const days = b.expiresInDays ?? config.HANDOVER_LINK_DAYS;
  const created = await db
    .transaction(async (tx) => {
      const [s] = await tx
        .insert(handoverSessions)
        .values({ organizationId: access.orgId, vehicleId: v.id, driverId: d.id, projectId: v.projectId, createdBy: access.userId, tokenHash: hashToken(token), expiresAt: new Date(now().getTime() + days * 86_400_000) })
        .returning();
      await audit(tx, req, { action: "HANDOVER_CREATED", entity: "handover", entityId: s!.id, projectId: v.projectId, vehicleId: v.id, metadata: { driverId: d.id, driverName: d.fullName, expiresAt: s!.expiresAt.toISOString() } });
      if (d.userId && d.userId !== access.userId) {
        await notifyUsers(tx, { orgId: access.orgId, userIds: [d.userId], type: "HANDOVER_REQUESTED", title: `مطلوب استلام المركبة ${v.plateNumber} وتصويرها`, link: `/handovers/${s!.id}`, entityType: "handover", entityId: s!.id, projectId: v.projectId });
      }
      return s!;
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "CONFLICT", "توجد جلسة تسليم نشطة لهذه المركبة أو لهذا السائق");
      throw e;
    });
  const { tokenHash: _t, ...safe } = created;
  // The raw token is returned exactly once; only its hash is stored.
  res.status(201).json({ data: { ...safe, link: linkFor(token), token } });
});

async function manageable(a: Access, id: string) {
  const s = await loadSession(a, id, "handover.manage");
  const m = a.require("handover.manage");
  if (m === "ASSIGNED" || (m === "PROJECT" && !a.isMemberOf(s.projectId))) throw forbidden();
  return s;
}

handoverRouter.post("/handovers/:id/rotate-link", requirePermission("handover.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const s = await manageable(access, id);
  if (!ACTIVE.includes(s.status)) throw new HttpError(409, "INVALID_TRANSITION", "الجلسة غير نشطة");
  const token = newToken();
  const expiresAt = new Date(now().getTime() + config.HANDOVER_LINK_DAYS * 86_400_000);
  await db.transaction(async (tx) => {
    await tx.update(handoverSessions).set({ tokenHash: hashToken(token), expiresAt, updatedAt: new Date() }).where(eq(handoverSessions.id, id));
    await audit(tx, req, { action: "HANDOVER_LINK_ROTATED", entity: "handover", entityId: id, projectId: s.projectId, vehicleId: s.vehicleId, metadata: { expiresAt: expiresAt.toISOString() } });
  });
  res.json({ data: { link: linkFor(token), token, expiresAt } });
});

handoverRouter.post("/handovers/:id/cancel", requirePermission("handover.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const s = await manageable(access, id);
  const { reason } = z.object({ reason: trimmed(3, 1000) }).strict().parse(req.body);
  const [u] = await db.transaction(async (tx) => {
    const r = await tx.update(handoverSessions).set({ status: "CANCELLED", cancelledAt: now(), cancelReason: reason, updatedAt: new Date() }).where(and(eq(handoverSessions.id, id), eq(handoverSessions.status, "PENDING_HANDOVER"))).returning();
    if (!r.length) throw new HttpError(409, "INVALID_TRANSITION", "يمكن إلغاء الجلسة قبل التسليم فقط");
    await audit(tx, req, { action: "HANDOVER_CANCELLED", entity: "handover", entityId: id, projectId: s.projectId, vehicleId: s.vehicleId, metadata: { reason, fromStatus: s.status, toStatus: "CANCELLED" } });
    const du = await driverUserId(tx, s.driverId);
    if (du) await notifyUsers(tx, { orgId: access.orgId, userIds: [du], type: "HANDOVER_CANCELLED", title: "تم إلغاء طلب استلام المركبة", link: `/handovers/${id}`, entityType: "handover", entityId: id, projectId: s.projectId });
    return r;
  });
  res.json({ data: { id: u!.id, status: u!.status } });
});

handoverRouter.post("/handovers/:id/close", requirePermission("handover.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const s = await manageable(access, id);
  const { reviewNotes } = z.object({ reviewNotes: optionalText(2000) }).strict().parse(req.body ?? {});
  const [u] = await db.transaction(async (tx) => {
    const r = await tx.update(handoverSessions).set({ status: "CLOSED", closedAt: now(), closedBy: access.userId, reviewNotes: reviewNotes ?? null, updatedAt: new Date() }).where(and(eq(handoverSessions.id, id), eq(handoverSessions.status, "RETURN_COMPLETED"))).returning();
    if (!r.length) throw new HttpError(409, "INVALID_TRANSITION", "يمكن إغلاق الجلسة بعد إكمال الإرجاع فقط");
    await audit(tx, req, { action: "HANDOVER_CLOSED", entity: "handover", entityId: id, projectId: s.projectId, vehicleId: s.vehicleId, metadata: { reviewNotes, fromStatus: "RETURN_COMPLETED", toStatus: "CLOSED" } });
    return r;
  });
  res.json({ data: { id: u!.id, status: u!.status } });
});

handoverRouter.get("/handover-photos/:id/file", requirePermission("handover.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [p] = await db.select().from(handoverPhotos).where(and(eq(handoverPhotos.id, id), eq(handoverPhotos.organizationId, access.orgId)));
  if (!p) throw notFound("الصورة غير موجودة");
  const s = await loadSession(access, p.sessionId);
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "handover", entityId: s.id, projectId: s.projectId, vehicleId: s.vehicleId, metadata: { photoId: id, category: p.category } });
  await sendStoredFile(db, res, p.fileId);
});

/** Driver (logged in) performing the handover/return without the link. */
async function asDriver(a: Access, id: string) {
  const s = await loadSession(a, id);
  if ((await driverUserId(db, s.driverId)) !== a.userId) throw forbidden("هذه الجلسة لسائق آخر");
  if (s.expiresAt.getTime() < now().getTime()) throw new HttpError(410, "EXPIRED", "انتهت صلاحية الجلسة");
  return s;
}

const CategoryParam = z.object({ id: uuid, category: z.enum(handoverPhotoCategory.enumValues) });

handoverRouter.put("/handovers/:id/photos/:category", requirePermission("handover.read"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id, category } = CategoryParam.parse(req.params);
  const s = await asDriver(access, id);
  res.status(201).json({ data: await uploadPhoto(req, s, category, access.userId) });
});

handoverRouter.post("/handovers/:id/submit", requirePermission("handover.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const s = await asDriver(access, id);
  const u = await submitPhase(req, s, access.userId);
  res.json({ data: { id: u.id, status: u.status } });
});

// ---------------------------------------------------------------- public link API

const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const publicTokenLimiter = new PgRateLimiter("handover-token", 120, 10 * 60_000);
export const publicInvalidLimiter = new PgRateLimiter("handover-invalid", 20, 15 * 60_000);
const publicRate = pgRateLimit(publicTokenLimiter, (req) => req.ip ?? "anon");

/**
 * Resolves a link token → active session. Invalid/expired tokens return the same
 * 404 (no oracle), are audited, and count against a stricter per-IP limiter.
 */
async function sessionFromToken(req: Request): Promise<Session> {
  const ip = req.ip ?? "anon";
  if (await publicInvalidLimiter.blocked(ip)) throw new HttpError(429, "RATE_LIMITED", "محاولات كثيرة، حاول لاحقًا");
  const parsed = TokenParam.safeParse(req.params);
  const s = parsed.success ? (await db.select().from(handoverSessions).where(eq(handoverSessions.tokenHash, hashToken(parsed.data.token))).limit(1))[0] : undefined;
  const valid = s && ACTIVE.includes(s.status) && s.expiresAt.getTime() > now().getTime();
  if (!valid) {
    await publicInvalidLimiter.hit(ip);
    await audit(db, req, { action: "HANDOVER_TOKEN_INVALID", entity: "handover", entityId: s?.id ?? null, orgId: s?.organizationId ?? null, userId: null, metadata: { reason: !s ? "unknown" : ACTIVE.includes(s.status) ? "expired" : "inactive" } });
    throw notFound("الرابط غير صالح أو منتهي الصلاحية");
  }
  await db.update(handoverSessions).set({ lastAccessAt: now(), accessCount: sql`${handoverSessions.accessCount} + 1` }).where(eq(handoverSessions.id, s.id));
  return s;
}

publicHandoverRouter.use(publicRate);

publicHandoverRouter.get("/handover/:token", async (req, res) => {
  const s = await sessionFromToken(req);
  const [[info], photos] = await Promise.all([
    db
      .select({ plateNumber: vehicles.plateNumber, plateArabic: vehicles.plateArabic, make: vehicles.make, model: vehicles.model, color: vehicles.color, currentOdometer: vehicles.currentOdometer, driverName: driverNameSql(handoverSessions.driverId), projectName: projects.name })
      .from(handoverSessions)
      .innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId))
      .leftJoin(projects, eq(projects.id, handoverSessions.projectId))
      .where(eq(handoverSessions.id, s.id)),
    photosOf(s.id),
  ]);
  // Minimal data only: no ids of other records, no file contents, no user data beyond the driver's name.
  res.json({
    data: {
      status: s.status,
      expiresAt: s.expiresAt,
      vehicle: info ? { plateNumber: info.plateNumber, plateArabic: info.plateArabic, make: info.make, model: info.model, color: info.color, currentOdometer: info.currentOdometer } : null,
      driverName: info?.driverName ?? null,
      projectName: info?.projectName ?? null,
      handover: { at: s.handoverAt, odometer: s.handoverOdometer },
      progress: progress(s, photos),
    },
  });
});

const PublicCategory = z.object({ token: z.string(), category: z.enum(handoverPhotoCategory.enumValues) });

publicHandoverRouter.put("/handover/:token/photos/:category", pgRateLimit(new PgRateLimiter("handover-upload", 60, 10 * 60_000), (req) => req.ip ?? "anon"), rawUpload, async (req, res) => {
  const { category } = PublicCategory.parse(req.params);
  const s = await sessionFromToken(req);
  res.status(201).json({ data: await uploadPhoto(req, s, category, await driverUserId(db, s.driverId)) });
});

publicHandoverRouter.post("/handover/:token/submit", async (req, res) => {
  const s = await sessionFromToken(req);
  const u = await submitPhase(req, s, await driverUserId(db, s.driverId));
  res.json({ data: { status: u.status } });
});

