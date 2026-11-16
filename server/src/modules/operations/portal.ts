import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { driverScope, getProjectInScope } from "../../auth/access.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { driverPortalLinks, drivers, employees, handoverSessions, projects, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { forbidden, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, paged, pagination, uuid } from "../../http/validate.js";
import { now } from "../../lib/clock.js";
import { PgRateLimiter, pgRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { driverEffectiveStatus } from "../../services/expiry.js";
import { tr } from "../../i18n/index.js";
import { ACTIVE, BLOCKED_VEHICLE, driverUserId, hashToken, newToken, photosOf, progress, submitPhase, uploadPhoto } from "./handover.js";
import { rawUpload } from "./common.js";

/**
 * Driver portal: ONE permanent link per driver (/p/<token>). The driver sees the vehicles of his CURRENT project
 * (read from his employee record on every request), takes one available vehicle, completes the photos, confirms,
 * and later returns the same vehicle the same way. Everything is checked here, on the server; the one-vehicle-per-
 * driver and one-driver-per-vehicle rules are also unique indexes on handover_sessions.
 *
 * The take / return steps reuse the handover session machinery (photos, odometer, confirmation, audit, notifications),
 * so there is a single custody history. No electronic signature is collected.
 */
export const publicPortalRouter = Router();
export const portalAdminRouter = Router();

const portalLink = (token: string) => `${config.publicAppUrl}/p/${token}`;
const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const tokenLimiter = new PgRateLimiter("portal-token", 240, 10 * 60_000);
const invalidLimiter = new PgRateLimiter("portal-invalid", 20, 15 * 60_000);
const identityLimiter = new PgRateLimiter("portal-identity", 5, 15 * 60_000);
const uploadLimiter = new PgRateLimiter("portal-upload", 90, 10 * 60_000);

type SessionRow = typeof handoverSessions.$inferSelect;

// ---------------------------------------------------------------- link → driver

type Who = {
  linkId: string;
  driverId: string;
  orgId: string;
  fullName: string;
  employeeNumber: string;
  projectId: string | null;
  projectName: string | null;
  effective: ReturnType<typeof driverEffectiveStatus>;
};

/**
 * Token → driver. An unknown, revoked or replaced token (or an archived driver) gets the same 404, is audited and counts
 * against a stricter per-IP limiter. The database is consulted on every request: a revoked token is dead immediately.
 */
async function whoFromToken(req: Request): Promise<Who> {
  const ip = req.ip ?? "anon";
  if (await invalidLimiter.blocked(ip)) throw new HttpError(429, "RATE_LIMITED", tr("محاولات كثيرة، حاول لاحقًا"));
  const parsed = TokenParam.safeParse(req.params);
  const [row] = parsed.success
    ? await db
        .select({
          linkId: driverPortalLinks.id,
          linkStatus: driverPortalLinks.status,
          linkOrg: driverPortalLinks.organizationId,
          driverId: drivers.id,
          driverOrg: drivers.organizationId,
          driverStatus: drivers.status,
          archivedAt: drivers.archivedAt,
          licenseExpiryDate: drivers.licenseExpiryDate,
          employeeStatus: employees.status,
          fullName: employees.fullName,
          employeeNumber: employees.employeeNumber,
          projectId: employees.projectId,
          projectName: projects.name,
        })
        .from(driverPortalLinks)
        .innerJoin(drivers, eq(drivers.id, driverPortalLinks.driverId))
        .innerJoin(employees, eq(employees.id, drivers.employeeId))
        .leftJoin(projects, eq(projects.id, employees.projectId))
        .where(eq(driverPortalLinks.tokenHash, hashToken(parsed.data.token)))
        .limit(1)
    : [];
  const valid = row && row.linkStatus === "ACTIVE" && !row.archivedAt && row.linkOrg === row.driverOrg;
  if (!valid) {
    await invalidLimiter.hit(ip);
    await audit(db, req, { action: "DRIVER_PORTAL_TOKEN_INVALID", entity: "driver_portal", entityId: row?.driverId ?? null, orgId: row?.driverOrg ?? null, userId: null, metadata: { reason: !row ? "unknown" : row.archivedAt ? "driver_archived" : row.linkStatus.toLowerCase() } });
    throw notFound(tr("هذا الرابط غير فعال"));
  }
  await db.update(driverPortalLinks).set({ lastAccessAt: now(), accessCount: sql`${driverPortalLinks.accessCount} + 1` }).where(eq(driverPortalLinks.id, row.linkId));
  return {
    linkId: row.linkId,
    driverId: row.driverId,
    orgId: row.driverOrg,
    fullName: row.fullName,
    employeeNumber: row.employeeNumber,
    projectId: row.projectId,
    projectName: row.projectName,
    effective: driverEffectiveStatus(row.driverStatus, row.licenseExpiryDate, row.employeeStatus),
  };
}

const digest = (s: string) => createHash("sha256").update(s.normalize("NFKC").replace(/\s+/g, "").toLowerCase()).digest();

/**
 * Sensitive actions (taking a vehicle, confirming a handover/return, cancelling) need the driver to type his employee
 * number, on top of the secret link. Wrong answers are counted per driver and lock the actions for a while.
 */
async function confirmIdentity(req: Request, who: Who): Promise<void> {
  if (await identityLimiter.blocked(who.driverId)) throw new HttpError(429, "RATE_LIMITED", tr("محاولات تحقق كثيرة، حاول لاحقًا أو تواصل مع المسؤول"));
  const given = (req.body as { employeeNumber?: unknown } | undefined)?.employeeNumber;
  const ok = typeof given === "string" && given.length > 0 && given.length < 100 && timingSafeEqual(digest(given), digest(who.employeeNumber));
  if (!ok) {
    await identityLimiter.hit(who.driverId);
    await audit(db, req, { action: "DRIVER_PORTAL_IDENTITY_FAILED", entity: "driver_portal", entityId: who.driverId, orgId: who.orgId, userId: null, metadata: { driverId: who.driverId } });
    throw forbidden(tr("رقم الموظف غير صحيح"));
  }
  if (req.body && typeof req.body === "object") delete (req.body as Record<string, unknown>).employeeNumber; // the submit schema is strict
}

publicPortalRouter.use(pgRateLimit(tokenLimiter, (req) => req.ip ?? "anon"));

// ---------------------------------------------------------------- driver views

async function activeSessionOf(driverId: string): Promise<SessionRow | undefined> {
  const [s] = await db.select().from(handoverSessions).where(and(eq(handoverSessions.driverId, driverId), inArray(handoverSessions.status, ACTIVE))).limit(1);
  return s;
}

async function view(who: Who) {
  const custody = await activeSessionOf(who.driverId);
  const [held] = custody ? [] : await db.select({ id: vehicles.id, plateNumber: vehicles.plateNumber }).from(vehicles).where(and(eq(vehicles.organizationId, who.orgId), eq(vehicles.assignedDriverId, who.driverId), isNull(vehicles.archivedAt))).limit(1);

  const vehicleCols = { id: vehicles.id, plateNumber: vehicles.plateNumber, plateArabic: vehicles.plateArabic, make: vehicles.make, model: vehicles.model, color: vehicles.color, status: vehicles.status, assignedDriverId: vehicles.assignedDriverId, currentOdometer: vehicles.currentOdometer };
  const inProject = who.projectId
    ? await db.select(vehicleCols).from(vehicles).where(and(eq(vehicles.organizationId, who.orgId), eq(vehicles.projectId, who.projectId), isNull(vehicles.archivedAt), ne(vehicles.status, "ARCHIVED"))).orderBy(asc(vehicles.plateNumber)).limit(500)
    : [];
  // the vehicle already in the driver's hands stays visible (and returnable) even after a project change
  const own = custody && !inProject.some((v) => v.id === custody.vehicleId) ? await db.select(vehicleCols).from(vehicles).where(and(eq(vehicles.id, custody.vehicleId), eq(vehicles.organizationId, who.orgId))) : [];
  const list = [...own, ...inProject];
  const active = list.length ? await db.select({ vehicleId: handoverSessions.vehicleId, driverId: handoverSessions.driverId }).from(handoverSessions).where(and(inArray(handoverSessions.vehicleId, list.map((v) => v.id)), inArray(handoverSessions.status, ACTIVE))) : [];
  const busyBy = new Map(active.map((a) => [a.vehicleId, a.driverId]));

  const canTakeAny = !custody && !held && who.effective === "ACTIVE" && !!who.projectId;
  const vehiclesOut = list.map((v) => {
    const holder = busyBy.get(v.id) ?? v.assignedDriverId;
    const state = custody?.vehicleId === v.id ? "MINE" : holder && holder !== who.driverId ? "TAKEN" : holder ? "ASSIGNED_TO_YOU" : v.status !== "AVAILABLE" || BLOCKED_VEHICLE.has(v.status) ? "UNAVAILABLE" : "AVAILABLE";
    return { id: v.id, plateNumber: v.plateNumber, plateArabic: v.plateArabic, make: v.make, model: v.model, color: v.color, status: v.status, state, canTake: state === "AVAILABLE" && canTakeAny };
  });
  const photos = custody ? await photosOf(custody.id) : [];
  const vehicleOf = custody ? list.find((v) => v.id === custody.vehicleId) : undefined;
  // Minimal data: nothing about other drivers, no ids of other records, no user data.
  return {
    driver: { name: who.fullName, active: who.effective === "ACTIVE" },
    project: who.projectId ? { name: who.projectName } : null,
    custody: custody
      ? {
          sessionId: custody.id,
          status: custody.status,
          vehicle: vehicleOf ? { plateNumber: vehicleOf.plateNumber, plateArabic: vehicleOf.plateArabic, make: vehicleOf.make, model: vehicleOf.model, color: vehicleOf.color, currentOdometer: vehicleOf.currentOdometer } : null,
          handover: { at: custody.handoverAt, odometer: custody.handoverOdometer },
          progress: progress(custody, photos),
          canCancel: custody.status === "PENDING_HANDOVER",
        }
      : null,
    heldElsewhere: held ? { plateNumber: held.plateNumber } : null,
    vehicles: vehiclesOut,
  };
}

publicPortalRouter.get("/:token", async (req, res) => {
  const who = await whoFromToken(req);
  res.json({ data: await view(who) });
});

const TakeBody = z.object({ employeeNumber: z.string().max(100) }).strict();

publicPortalRouter.post("/:token/vehicles/:vehicleId/take", async (req, res) => {
  const who = await whoFromToken(req);
  const { vehicleId } = z.object({ vehicleId: uuid }).parse(req.params);
  TakeBody.parse(req.body);
  await confirmIdentity(req, who);
  if (who.effective !== "ACTIVE") throw new HttpError(409, "NOT_ALLOWED", tr("حسابك غير نشط أو رخصتك منتهية؛ تواصل مع المسؤول"));
  if (!who.projectId) throw new HttpError(409, "NO_PROJECT", tr("لا يوجد مشروع مرتبط بحسابك؛ تواصل مع المسؤول"));
  const created = await db
    .transaction(async (tx) => {
      // the project is read again inside the transaction (it may have changed a moment ago)
      const [me] = await tx.select({ projectId: employees.projectId }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(drivers.id, who.driverId));
      if (!me?.projectId) throw new HttpError(409, "NO_PROJECT", tr("لا يوجد مشروع مرتبط بحسابك؛ تواصل مع المسؤول"));
      const [v] = await tx.select().from(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.organizationId, who.orgId))).for("update");
      if (!v || v.projectId !== me.projectId || v.archivedAt) throw notFound(tr("المركبة غير موجودة")); // other projects never exist for the driver
      const [mine] = await tx.select({ plate: vehicles.plateNumber }).from(handoverSessions).innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId)).where(and(eq(handoverSessions.driverId, who.driverId), inArray(handoverSessions.status, ACTIVE))).limit(1);
      if (mine) throw new HttpError(409, "CUSTODY_OPEN", tr("لديك مركبة بعهدتك ({0}). سلّمها أولًا قبل استلام مركبة أخرى", mine.plate));
      const [held] = await tx.select({ plate: vehicles.plateNumber }).from(vehicles).where(and(eq(vehicles.assignedDriverId, who.driverId), isNull(vehicles.archivedAt))).limit(1);
      if (held) throw new HttpError(409, "CUSTODY_OPEN", tr("لديك مركبة بعهدتك ({0}). سلّمها أولًا قبل استلام مركبة أخرى", held.plate));
      if (v.status !== "AVAILABLE" || BLOCKED_VEHICLE.has(v.status) || v.assignedDriverId) throw new HttpError(409, "VEHICLE_UNAVAILABLE", tr("هذه المركبة غير متاحة للاستلام الآن"));
      const [s] = await tx
        .insert(handoverSessions)
        .values({
          organizationId: who.orgId,
          vehicleId: v.id,
          driverId: who.driverId,
          projectId: v.projectId,
          createdBy: (await tx.select({ by: driverPortalLinks.createdBy }).from(driverPortalLinks).where(eq(driverPortalLinks.id, who.linkId)))[0]!.by,
          tokenHash: hashToken(randomBytes(32).toString("base64url")), // never handed out: portal sessions have no link of their own
          linkStatus: "REVOKED",
          linkRevokedAt: now(),
          viaPortal: true,
        })
        .returning();
      await audit(tx, req, { action: "HANDOVER_CREATED", entity: "handover", entityId: s!.id, projectId: v.projectId, vehicleId: v.id, orgId: who.orgId, userId: null, metadata: { driverId: who.driverId, driverName: who.fullName, via: "driver_portal" } });
      return s!;
    })
    .catch((e: unknown) => {
      const pg = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint?: string };
      if (pg.code === "23505") {
        if (pg.constraint === "handover_one_active_per_driver_uq") throw new HttpError(409, "CUSTODY_OPEN", tr("لديك مركبة بعهدتك. سلّمها أولًا قبل استلام مركبة أخرى"));
        throw new HttpError(409, "VEHICLE_UNAVAILABLE", tr("هذه المركبة غير متاحة للاستلام الآن"));
      }
      throw e;
    });
  res.status(201).json({ data: { sessionId: created.id } });
});

/** The session of this driver (never another driver's), still open. */
async function ownSession(who: Who, sessionId: string): Promise<SessionRow> {
  const [s] = await db.select().from(handoverSessions).where(and(eq(handoverSessions.id, sessionId), eq(handoverSessions.driverId, who.driverId), eq(handoverSessions.organizationId, who.orgId), inArray(handoverSessions.status, ACTIVE))).limit(1);
  if (!s) throw notFound(tr("جلسة التسليم غير موجودة"));
  return s;
}
const SessionParams = z.object({ sessionId: uuid });

publicPortalRouter.put("/:token/sessions/:sessionId/photos/:category", pgRateLimit(uploadLimiter, (req) => req.ip ?? "anon"), rawUpload, async (req, res) => {
  const who = await whoFromToken(req);
  const { sessionId } = SessionParams.parse(req.params);
  const category = z.enum(["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES", "OTHER", "SIGNATURE"]).parse(req.params.category);
  const s = await ownSession(who, sessionId);
  res.status(201).json({ data: await uploadPhoto(req, s, category, await driverUserId(db, who.driverId)) });
});

publicPortalRouter.post("/:token/sessions/:sessionId/submit", async (req, res) => {
  const who = await whoFromToken(req);
  const { sessionId } = SessionParams.parse(req.params);
  const s = await ownSession(who, sessionId);
  await confirmIdentity(req, who);
  // a driver may always return what he holds; a new pickup also needs an active account
  if (s.status === "PENDING_HANDOVER" && who.effective !== "ACTIVE") throw new HttpError(409, "NOT_ALLOWED", tr("حسابك غير نشط أو رخصتك منتهية؛ تواصل مع المسؤول"));
  const u = await submitPhase(req, s, await driverUserId(db, who.driverId));
  res.json({ data: { status: u.status } });
});

publicPortalRouter.post("/:token/sessions/:sessionId/cancel", async (req, res) => {
  const who = await whoFromToken(req);
  const { sessionId } = SessionParams.parse(req.params);
  const s = await ownSession(who, sessionId);
  await confirmIdentity(req, who);
  const [u] = await db.transaction(async (tx) => {
    const r = await tx.update(handoverSessions).set({ status: "CANCELLED", cancelledAt: now(), cancelReason: tr("ألغاه السائق من البوابة قبل إتمام الاستلام"), updatedAt: new Date() }).where(and(eq(handoverSessions.id, s.id), eq(handoverSessions.status, "PENDING_HANDOVER"))).returning();
    if (!r.length) throw new HttpError(409, "INVALID_TRANSITION", tr("يمكن إلغاء الاستلام قبل إتمامه فقط"));
    await audit(tx, req, { action: "HANDOVER_CANCELLED", entity: "handover", entityId: s.id, projectId: s.projectId, vehicleId: s.vehicleId, orgId: s.organizationId, userId: null, metadata: { via: "driver_portal", driverId: who.driverId, fromStatus: s.status, toStatus: "CANCELLED" } });
    return r;
  });
  res.json({ data: { id: u!.id, status: u!.status } });
});

// ---------------------------------------------------------------- administration (authenticated)

const perm = [requirePermission("handover.read"), requirePermission("drivers.read")];
const manage = [requirePermission("handover.manage"), requirePermission("drivers.read")];

portalAdminRouter.get("/drivers", ...perm, async (req, res) => {
  const { access } = ctx(req);
  const q = pagination.extend({ q: z.string().trim().max(100).optional(), projectId: uuid.optional(), withoutLink: z.enum(["true", "false"]).optional() }).parse(req.query);
  const where = [driverScope(access, "drivers.read"), isNull(drivers.archivedAt)];
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(or(ilike(employees.fullName, like), ilike(employees.employeeNumber, like))!);
  }
  if (q.projectId) where.push(eq(employees.projectId, q.projectId));
  if (q.withoutLink === "true") where.push(sql`not exists (select 1 from driver_portal_links l where l.driver_id = ${drivers.id})`);
  const cond = and(...where);
  const base = db.select({ id: drivers.id, fullName: employees.fullName, employeeNumber: employees.employeeNumber, projectId: employees.projectId, projectName: projects.name, status: drivers.status, licenseExpiryDate: drivers.licenseExpiryDate, employeeStatus: employees.status }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).leftJoin(projects, eq(projects.id, employees.projectId));
  const [rows, [count]] = await Promise.all([
    base.where(cond).orderBy(asc(employees.fullName)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(cond),
  ]);
  const ids = rows.map((r) => r.id);
  const links = ids.length ? await db.select().from(driverPortalLinks).where(and(eq(driverPortalLinks.organizationId, access.orgId), inArray(driverPortalLinks.driverId, ids))) : [];
  const sessions = ids.length
    ? await db.select({ id: handoverSessions.id, driverId: handoverSessions.driverId, status: handoverSessions.status, plateNumber: vehicles.plateNumber, handoverAt: handoverSessions.handoverAt, viaPortal: handoverSessions.viaPortal }).from(handoverSessions).innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId)).where(and(eq(handoverSessions.organizationId, access.orgId), inArray(handoverSessions.driverId, ids), inArray(handoverSessions.status, ACTIVE)))
    : [];
  const linkOf = new Map(links.map((l) => [l.driverId, l]));
  const sessionOf = new Map(sessions.map((s) => [s.driverId, s]));
  res.json(
    paged(
      rows.map((r) => {
        const l = linkOf.get(r.id);
        const s = sessionOf.get(r.id);
        return {
          id: r.id,
          fullName: r.fullName,
          employeeNumber: r.employeeNumber,
          projectId: r.projectId,
          projectName: r.projectName,
          driverStatus: driverEffectiveStatus(r.status, r.licenseExpiryDate, r.employeeStatus),
          link: l ? { status: l.status, createdAt: l.createdAt, rotatedAt: l.rotatedAt, revokedAt: l.revokedAt, lastAccessAt: l.lastAccessAt, accessCount: l.accessCount } : null,
          custody: s ? { sessionId: s.id, status: s.status, plateNumber: s.plateNumber, handoverAt: s.handoverAt, viaPortal: s.viaPortal } : null,
        };
      }),
      count?.n ?? 0,
      q.page,
      q.pageSize,
    ),
  );
});

async function managedDriver(req: Request) {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [d] = await db
    .select({ id: drivers.id, projectId: employees.projectId, fullName: employees.fullName })
    .from(drivers)
    .innerJoin(employees, eq(employees.id, drivers.employeeId))
    .where(and(eq(drivers.id, id), isNull(drivers.archivedAt), driverScope(access, "drivers.read")))
    .limit(1);
  if (!d) throw notFound(tr("السائق غير موجود"));
  const m = access.require("handover.manage");
  if (m === "ASSIGNED" || (m === "PROJECT" && !access.isMemberOf(d.projectId))) throw forbidden();
  return { access, d };
}

/** Creates the driver's permanent link, or renews it (new token, the old one stops at once; also reopens a revoked one). */
portalAdminRouter.post("/drivers/:id/link", ...manage, async (req, res) => {
  const { access, d } = await managedDriver(req);
  const token = newToken();
  const [existing] = await db.select().from(driverPortalLinks).where(eq(driverPortalLinks.driverId, d.id));
  if (existing) {
    await db.update(driverPortalLinks).set({ tokenHash: hashToken(token), status: "ACTIVE", rotatedAt: now(), rotatedBy: access.userId, revokedAt: null, revokedBy: null }).where(eq(driverPortalLinks.id, existing.id));
  } else {
    await db.insert(driverPortalLinks).values({ organizationId: access.orgId, driverId: d.id, tokenHash: hashToken(token), createdBy: access.userId });
  }
  await audit(db, req, { action: existing ? "DRIVER_PORTAL_LINK_RENEWED" : "DRIVER_PORTAL_LINK_CREATED", entity: "driver_portal", entityId: d.id, projectId: d.projectId, metadata: { driverId: d.id, driverName: d.fullName, wasRevoked: existing?.status === "REVOKED" } });
  // The raw token is shown exactly once; only its hash is stored.
  res.status(existing ? 200 : 201).json({ data: { link: portalLink(token), status: "ACTIVE", renewed: !!existing } });
});

portalAdminRouter.post("/drivers/:id/link/revoke", ...manage, async (req, res) => {
  const { access, d } = await managedDriver(req);
  const [row] = await db.update(driverPortalLinks).set({ status: "REVOKED", revokedAt: now(), revokedBy: access.userId }).where(and(eq(driverPortalLinks.driverId, d.id), eq(driverPortalLinks.status, "ACTIVE"))).returning();
  if (!row) throw new HttpError(409, "INVALID_TRANSITION", tr("لا يوجد رابط فعال لهذا السائق"));
  await audit(db, req, { action: "DRIVER_PORTAL_LINK_REVOKED", entity: "driver_portal", entityId: d.id, projectId: d.projectId, metadata: { driverId: d.id, driverName: d.fullName } });
  res.json({ data: { status: "REVOKED" } });
});

/** Vehicles of one project with who holds them: available / occupied (by whom, since when) / unavailable. */
portalAdminRouter.get("/projects/:id/vehicles", ...perm, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  const list = await db.select({ id: vehicles.id, plateNumber: vehicles.plateNumber, make: vehicles.make, model: vehicles.model, status: vehicles.status, assignedDriverId: vehicles.assignedDriverId }).from(vehicles).where(and(eq(vehicles.organizationId, access.orgId), eq(vehicles.projectId, project.id), isNull(vehicles.archivedAt))).orderBy(asc(vehicles.plateNumber)).limit(1000);
  const ids = list.map((v) => v.id);
  const sessions = ids.length
    ? await db.select({ id: handoverSessions.id, vehicleId: handoverSessions.vehicleId, status: handoverSessions.status, handoverAt: handoverSessions.handoverAt, driverName: employees.fullName }).from(handoverSessions).innerJoin(drivers, eq(drivers.id, handoverSessions.driverId)).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(and(inArray(handoverSessions.vehicleId, ids), inArray(handoverSessions.status, ACTIVE)))
    : [];
  const byVehicle = new Map(sessions.map((s) => [s.vehicleId, s]));
  const named = new Map<string, string>();
  const assignedIds = list.map((v) => v.assignedDriverId).filter((x): x is string => !!x);
  if (assignedIds.length) for (const r of await db.select({ id: drivers.id, name: employees.fullName }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(inArray(drivers.id, assignedIds))) named.set(r.id, r.name);
  const out = list.map((v) => {
    const s = byVehicle.get(v.id);
    const state = s || v.assignedDriverId ? "OCCUPIED" : v.status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE";
    return { id: v.id, plateNumber: v.plateNumber, make: v.make, model: v.model, status: v.status, state, driverName: s?.driverName ?? (v.assignedDriverId ? (named.get(v.assignedDriverId) ?? null) : null), sessionId: s?.id ?? null, sessionStatus: s?.status ?? null, since: s?.handoverAt ?? null };
  });
  res.json({ data: out, meta: { project: project.name, available: out.filter((v) => v.state === "AVAILABLE").length, occupied: out.filter((v) => v.state === "OCCUPIED").length, unavailable: out.filter((v) => v.state === "UNAVAILABLE").length } });
});

