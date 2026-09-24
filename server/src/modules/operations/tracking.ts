import { and, asc, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { ownDriverId, recordScope, driverIsUser, vehicleScope, type Access } from "../../auth/access.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { locationPings, projects, trackingSource, trips, vehicleLocations, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requireAnyPermission, requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, paged, pagination, uuid } from "../../http/validate.js";
import { now } from "../../lib/clock.js";
import { PgRateLimiter, pgRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { driverNameSql } from "./common.js";

/**
 * GPS V1. The web/PWA tracker and a future native app use the same endpoints
 * (`source` = WEB | NATIVE). Positions are only ever the ones the device sent;
 * nothing is interpolated or invented.
 */
export const trackingRouter = Router();

const pingLimiter = new PgRateLimiter("gps-ping", 240, 10 * 60_000);
const pingRate = pgRateLimit(pingLimiter, (req) => req.session?.userId ?? req.ip ?? "anon");

/** Max plausible speed between two consecutive points (km/h); faster jumps are ignored for distance. */
const MAX_SPEED_KMH = 250;
/** Points less accurate than this (metres) are stored but not used for distance. */
const MAX_ACCURACY_M = 200;
const STALE_MINUTES = 15;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function tripScope(a: Access): SQL {
  return recordScope(a, "gps.read", { orgCol: trips.organizationId, projectCol: trips.projectId, assigned: sql`(${driverIsUser(a, trips.driverId)})` });
}

/** Own trips are always visible to the driver (gps.track), other trips need gps.read scope. */
function visibleTrips(a: Access): SQL {
  const own = sql`${trips.userId} = ${a.userId}`;
  return a.has("gps.read") ? sql`(${own} or ${tripScope(a)})` : and(eq(trips.organizationId, a.orgId), own)!;
}

const StartBody = z.object({ vehicleId: uuid, source: z.enum(trackingSource.enumValues).default("WEB") }).strict();

trackingRouter.post("/tracking/trips", requirePermission("gps.track"), async (req, res) => {
  const { access } = ctx(req);
  const b = StartBody.parse(req.body);
  const driverId = await ownDriverId(db, access);
  if (!driverId) throw forbidden("لا يوجد ملف سائق مرتبط بحسابك");
  const [v] = await db.select().from(vehicles).where(and(eq(vehicles.id, b.vehicleId), eq(vehicles.organizationId, access.orgId)));
  if (!v) throw notFound("المركبة غير موجودة");
  if (v.assignedDriverId !== driverId) throw forbidden("المركبة غير مسندة إليك");
  const trip = await db
    .transaction(async (tx) => {
      const [t] = await tx.insert(trips).values({ organizationId: access.orgId, driverId, vehicleId: v.id, projectId: v.projectId, userId: access.userId, source: b.source }).returning();
      await audit(tx, req, { action: "TRIP_STARTED", entity: "trip", entityId: t!.id, projectId: v.projectId, vehicleId: v.id, metadata: { source: b.source } });
      return t!;
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "CONFLICT", "توجد رحلة نشطة لك أو لهذه المركبة");
      throw e;
    });
  res.status(201).json({ data: trip });
});

trackingRouter.get("/tracking/trips/active", requirePermission("gps.track"), async (req, res) => {
  const { access } = ctx(req);
  const [t] = await db
    .select({ trip: trips, plateNumber: vehicles.plateNumber })
    .from(trips)
    .innerJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .where(and(eq(trips.userId, access.userId), eq(trips.status, "ACTIVE")))
    .limit(1);
  res.json({ data: t ? { ...t.trip, plateNumber: t.plateNumber } : null });
});

const Point = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
  speed: z.number().min(0).max(200).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  recordedAt: z.iso.datetime({ offset: true }),
});
const PointsBody = z.object({ points: z.array(Point).min(1).max(100) }).strict();

async function ownActiveTrip(a: Access, id: string) {
  const [t] = await db.select().from(trips).where(and(eq(trips.id, id), eq(trips.organizationId, a.orgId), eq(trips.userId, a.userId))).limit(1);
  if (!t) throw notFound("الرحلة غير موجودة");
  if (t.status !== "ACTIVE") throw new HttpError(409, "INVALID_TRANSITION", "الرحلة منتهية");
  return t;
}

trackingRouter.post("/tracking/trips/:id/points", requirePermission("gps.track"), pingRate, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const t = await ownActiveTrip(access, id);
  const { points } = PointsBody.parse(req.body);
  const nowMs = now().getTime();
  const sorted = points
    .map((p) => ({ ...p, at: new Date(p.recordedAt) }))
    .filter((p) => p.at.getTime() <= nowMs + 2 * 60_000 && p.at.getTime() >= t.startedAt.getTime() - 60_000)
    .sort((x, y) => x.at.getTime() - y.at.getTime());
  if (!sorted.length) throw badRequest("لا توجد نقاط صالحة (تحقق من توقيت الجهاز)");
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(trips).where(eq(trips.id, t.id)).for("update");
    if (!locked || locked.status !== "ACTIVE") throw new HttpError(409, "INVALID_TRANSITION", "الرحلة منتهية");
    const [last] = await tx.select().from(locationPings).where(eq(locationPings.tripId, t.id)).orderBy(desc(locationPings.recordedAt)).limit(1);
    let prev = last ? { lat: Number(last.latitude), lng: Number(last.longitude), at: last.recordedAt } : null;
    let added = 0;
    const fresh = sorted.filter((p) => !last || p.at.getTime() > last.recordedAt.getTime());
    for (const p of fresh) {
      const usable = p.accuracy == null || p.accuracy <= MAX_ACCURACY_M;
      if (prev && usable) {
        const d = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
        const hours = (p.at.getTime() - prev.at.getTime()) / 3_600_000;
        if (hours > 0 && d / 1000 / hours <= MAX_SPEED_KMH) added += d;
      }
      if (usable) prev = { lat: p.lat, lng: p.lng, at: p.at };
    }
    if (fresh.length) {
      await tx.insert(locationPings).values(
        fresh.map((p) => ({
          organizationId: t.organizationId,
          tripId: t.id,
          driverId: t.driverId,
          vehicleId: t.vehicleId,
          projectId: t.projectId,
          latitude: p.lat.toFixed(6),
          longitude: p.lng.toFixed(6),
          accuracy: p.accuracy != null ? p.accuracy.toFixed(2) : null,
          speed: p.speed != null ? p.speed.toFixed(2) : null,
          heading: p.heading != null ? p.heading.toFixed(2) : null,
          recordedAt: p.at,
        })),
      );
      const lp = fresh[fresh.length - 1]!;
      await tx
        .update(trips)
        .set({ distanceMeters: sql`${trips.distanceMeters} + ${added.toFixed(1)}::numeric`, pointCount: sql`${trips.pointCount} + ${fresh.length}`, lastPointAt: lp.at })
        .where(eq(trips.id, t.id));
      const loc = { organizationId: t.organizationId, driverId: t.driverId, tripId: t.id, latitude: lp.lat.toFixed(6), longitude: lp.lng.toFixed(6), accuracy: lp.accuracy != null ? lp.accuracy.toFixed(2) : null, speed: lp.speed != null ? lp.speed.toFixed(2) : null, heading: lp.heading != null ? lp.heading.toFixed(2) : null, recordedAt: lp.at, updatedAt: new Date() };
      await tx
        .insert(vehicleLocations)
        .values({ vehicleId: t.vehicleId, ...loc })
        .onConflictDoUpdate({ target: vehicleLocations.vehicleId, set: loc, where: sql`${vehicleLocations.recordedAt} < excluded.recorded_at` });
    }
    return { accepted: fresh.length, ignored: points.length - fresh.length, distanceAddedMeters: Math.round(added) };
  });
  res.json({ data: result });
});

trackingRouter.post("/tracking/trips/:id/end", requirePermission("gps.track"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const t = await ownActiveTrip(access, id);
  const [u] = await db.transaction(async (tx) => {
    const r = await tx.update(trips).set({ status: "ENDED", endedAt: now() }).where(and(eq(trips.id, id), eq(trips.status, "ACTIVE"))).returning();
    if (!r.length) throw new HttpError(409, "INVALID_TRANSITION", "الرحلة منتهية");
    await audit(tx, req, { action: "TRIP_ENDED", entity: "trip", entityId: id, projectId: t.projectId, vehicleId: t.vehicleId, metadata: { distanceMeters: r[0]!.distanceMeters, points: r[0]!.pointCount } });
    return r;
  });
  res.json({ data: u });
});

/** Latest known position of every vehicle in scope (for the fleet map). */
trackingRouter.get("/tracking/latest", requirePermission("gps.read"), async (req, res) => {
  const { access } = ctx(req);
  const { projectId } = z.object({ projectId: uuid.optional() }).parse(req.query);
  const rows = await db
    .select({
      vehicleId: vehicleLocations.vehicleId,
      plateNumber: vehicles.plateNumber,
      status: vehicles.status,
      projectId: vehicles.projectId,
      projectName: projects.name,
      driverName: driverNameSql(vehicleLocations.driverId),
      latitude: vehicleLocations.latitude,
      longitude: vehicleLocations.longitude,
      accuracy: vehicleLocations.accuracy,
      speed: vehicleLocations.speed,
      heading: vehicleLocations.heading,
      recordedAt: vehicleLocations.recordedAt,
      tripActive: sql<boolean>`exists (select 1 from trips tt where tt.id = ${vehicleLocations.tripId} and tt.status = 'ACTIVE')`,
    })
    .from(vehicleLocations)
    .innerJoin(vehicles, eq(vehicles.id, vehicleLocations.vehicleId))
    .leftJoin(projects, eq(projects.id, vehicles.projectId))
    .where(and(vehicleScope(access, "gps.read"), projectId ? eq(vehicles.projectId, projectId) : undefined))
    .orderBy(desc(vehicleLocations.recordedAt))
    .limit(1000);
  const cutoff = now().getTime() - STALE_MINUTES * 60_000;
  res.json({ data: rows.map((r) => ({ ...r, stale: r.recordedAt.getTime() < cutoff })), meta: { staleMinutes: STALE_MINUTES } });
});

const TripsQuery = pagination.extend({ vehicleId: uuid.optional(), driverId: uuid.optional(), status: z.enum(["ACTIVE", "ENDED"]).optional(), from: isoDate.optional(), to: isoDate.optional() });

trackingRouter.get("/tracking/trips", requireAnyPermission("gps.read", "gps.track"), async (req, res) => {
  const { access } = ctx(req);
  const q = TripsQuery.parse(req.query);
  const tz = config.APP_TIMEZONE;
  const where: SQL[] = [visibleTrips(access)];
  if (q.vehicleId) where.push(eq(trips.vehicleId, q.vehicleId));
  if (q.driverId) where.push(eq(trips.driverId, q.driverId));
  if (q.status) where.push(eq(trips.status, q.status));
  if (q.from) where.push(sql`(${trips.startedAt} at time zone ${tz})::date >= ${q.from}::date`);
  if (q.to) where.push(sql`(${trips.startedAt} at time zone ${tz})::date <= ${q.to}::date`);
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db
      .select({ id: trips.id, vehicleId: trips.vehicleId, plateNumber: vehicles.plateNumber, driverId: trips.driverId, driverName: driverNameSql(trips.driverId), projectId: trips.projectId, source: trips.source, status: trips.status, startedAt: trips.startedAt, endedAt: trips.endedAt, distanceMeters: trips.distanceMeters, pointCount: trips.pointCount, lastPointAt: trips.lastPointAt })
      .from(trips)
      .innerJoin(vehicles, eq(vehicles.id, trips.vehicleId))
      .where(cond)
      .orderBy(desc(trips.startedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(trips).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

trackingRouter.get("/tracking/trips/:id/points", requireAnyPermission("gps.read", "gps.track"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { after } = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query);
  const [t] = await db.select().from(trips).where(and(eq(trips.id, id), visibleTrips(access))).limit(1);
  if (!t) throw notFound("الرحلة غير موجودة");
  const rows = await db
    .select({ id: locationPings.id, lat: locationPings.latitude, lng: locationPings.longitude, accuracy: locationPings.accuracy, speed: locationPings.speed, recordedAt: locationPings.recordedAt })
    .from(locationPings)
    .where(and(eq(locationPings.tripId, id), after ? gt(locationPings.id, after) : undefined))
    .orderBy(asc(locationPings.recordedAt))
    .limit(5000);
  res.json({ data: { trip: t, points: rows } });
});

// ---------------------------------------------------------------- map provider abstraction

/**
 * Map configuration for the client. The tile provider is chosen server-side:
 *  - MAP_TILE_URL unset → public OpenStreetMap tiles (no key needed)
 *  - MAP_TILE_URL set   → tiles are proxied through /api/map/tiles so a key in
 *                         the template never reaches the browser.
 */
trackingRouter.get("/config/map", async (_req, res) => {
  const [lat, lng] = config.MAP_DEFAULT_CENTER.split(",").map(Number);
  res.json({
    data: {
      provider: config.MAP_TILE_URL ? "proxy" : "osm",
      tileUrl: config.MAP_TILE_URL ? "/api/map/tiles/{z}/{x}/{y}" : "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: config.MAP_ATTRIBUTION,
      maxZoom: 19,
      center: { lat: Number.isFinite(lat) ? lat : 24.7136, lng: Number.isFinite(lng) ? lng : 46.6753 },
      zoom: 6,
    },
  });
});

const tileCache = new Map<string, { body: Buffer; type: string; at: number }>();
const TILE_TTL = 6 * 3_600_000;
const tileLimiter = new PgRateLimiter("map-tiles", 3000, 10 * 60_000);

trackingRouter.get("/map/tiles/:z/:x/:y", pgRateLimit(tileLimiter, (req) => req.session?.userId ?? "anon"), async (req, res) => {
  if (!config.MAP_TILE_URL) throw notFound("لا يوجد مزود خرائط مهيأ");
  const p = z.object({ z: z.coerce.number().int().min(0).max(20), x: z.coerce.number().int().min(0), y: z.coerce.number().int().min(0) }).parse(req.params);
  const max = 2 ** p.z;
  if (p.x >= max || p.y >= max) throw badRequest("إحداثيات غير صالحة");
  const key = `${p.z}/${p.x}/${p.y}`;
  const hit = tileCache.get(key);
  if (!hit || Date.now() - hit.at > TILE_TTL) {
    const url = config.MAP_TILE_URL.replace("{z}", String(p.z)).replace("{x}", String(p.x)).replace("{y}", String(p.y));
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) throw new HttpError(502, "UPSTREAM", "تعذر تحميل الخريطة");
    const body = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get("content-type") ?? "image/png";
    if (!/^image\//.test(type)) throw new HttpError(502, "UPSTREAM", "استجابة غير متوقعة من مزود الخرائط");
    if (tileCache.size > 5000) tileCache.clear();
    tileCache.set(key, { body, type, at: Date.now() });
  }
  const t = tileCache.get(key)!;
  res.setHeader("Content-Type", t.type);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.end(t.body);
});
