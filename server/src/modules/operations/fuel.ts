import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { fuelTransactions, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, optionalText, paged, pagination, uuid } from "../../http/validate.js";
import { config } from "../../config.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { assertNotFuture, driverNameSql, rawUpload, resolveDriver, vehicleForCreate, vehicleRecordScope } from "./common.js";

export const fuelRouter = Router();

export function fuelScope(a: Access, perm: "fuel.read" | "fuel.create" = "fuel.read"): SQL {
  return vehicleRecordScope(a, perm, fuelTransactions);
}

const columns = {
  id: fuelTransactions.id,
  vehicleId: fuelTransactions.vehicleId,
  plateNumber: vehicles.plateNumber,
  projectId: fuelTransactions.projectId,
  projectName: projects.name,
  driverId: fuelTransactions.driverId,
  driverName: driverNameSql(fuelTransactions.driverId),
  fueledAt: fuelTransactions.fueledAt,
  liters: fuelTransactions.liters,
  pricePerLiter: fuelTransactions.pricePerLiter,
  total: fuelTransactions.total,
  station: fuelTransactions.station,
  odometer: fuelTransactions.odometer,
  hasReceipt: sql<boolean>`(${fuelTransactions.receiptFileId} is not null)`,
  notes: fuelTransactions.notes,
  createdBy: fuelTransactions.createdBy,
  createdByName: users.name,
  createdAt: fuelTransactions.createdAt,
};

const base = () =>
  db
    .select(columns)
    .from(fuelTransactions)
    .innerJoin(vehicles, eq(vehicles.id, fuelTransactions.vehicleId))
    .leftJoin(projects, eq(projects.id, fuelTransactions.projectId))
    .innerJoin(users, eq(users.id, fuelTransactions.createdBy));

const Filters = z.object({
  vehicleId: uuid.optional(),
  driverId: uuid.optional(),
  projectId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

function filterWhere(a: Access, f: z.infer<typeof Filters>): SQL[] {
  const tz = config.APP_TIMEZONE;
  const where: SQL[] = [fuelScope(a)];
  if (f.vehicleId) where.push(eq(fuelTransactions.vehicleId, f.vehicleId));
  if (f.driverId) where.push(eq(fuelTransactions.driverId, f.driverId));
  if (f.projectId) where.push(eq(fuelTransactions.projectId, f.projectId));
  if (f.from) where.push(sql`(${fuelTransactions.fueledAt} at time zone ${tz})::date >= ${f.from}::date`);
  if (f.to) where.push(sql`(${fuelTransactions.fueledAt} at time zone ${tz})::date <= ${f.to}::date`);
  return where;
}

fuelRouter.get("/fuel", requirePermission("fuel.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = pagination.extend(Filters.shape).parse(req.query);
  const cond = and(...filterWhere(access, q));
  const [rows, [count]] = await Promise.all([
    base().where(cond).orderBy(desc(fuelTransactions.fueledAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(fuelTransactions).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

/**
 * Fuel statistics for the filtered set: totals, average price, monthly series
 * and per-vehicle consumption. km/L uses odometer deltas between consecutive
 * fill-ups of the same vehicle (fill-ups without an odometer are skipped).
 */
fuelRouter.get("/fuel/stats", requirePermission("fuel.read"), async (req, res) => {
  const { access } = ctx(req);
  const f = Filters.parse(req.query);
  const cond = and(...filterWhere(access, f));
  const tz = config.APP_TIMEZONE;
  const [totals] = await db
    .select({
      count: sql<number>`count(*)::int`,
      liters: sql<string>`coalesce(sum(${fuelTransactions.liters}), 0)::numeric(14,2)`,
      cost: sql<string>`coalesce(sum(${fuelTransactions.total}), 0)::numeric(14,2)`,
      avgPrice: sql<string | null>`(sum(${fuelTransactions.total}) / nullif(sum(${fuelTransactions.liters}), 0))::numeric(10,3)`,
    })
    .from(fuelTransactions)
    .where(cond);
  const monthly = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${fuelTransactions.fueledAt} at time zone ${tz}), 'YYYY-MM')`,
      liters: sql<string>`sum(${fuelTransactions.liters})::numeric(14,2)`,
      cost: sql<string>`sum(${fuelTransactions.total})::numeric(14,2)`,
    })
    .from(fuelTransactions)
    .where(cond)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const scoped = db
    .select({
      vehicleId: fuelTransactions.vehicleId,
      liters: fuelTransactions.liters,
      total: fuelTransactions.total,
      odometer: fuelTransactions.odometer,
      prevOdo: sql<number | null>`lag(${fuelTransactions.odometer}) over (partition by ${fuelTransactions.vehicleId} order by ${fuelTransactions.fueledAt})`.as("prev_odo"),
    })
    .from(fuelTransactions)
    .where(and(cond, sql`${fuelTransactions.odometer} is not null`))
    .as("s");
  const perVehicle = await db
    .select({
      vehicleId: scoped.vehicleId,
      plateNumber: vehicles.plateNumber,
      fills: sql<number>`count(*)::int`,
      liters: sql<string>`sum(${scoped.liters})::numeric(14,2)`,
      cost: sql<string>`sum(${scoped.total})::numeric(14,2)`,
      distanceKm: sql<number>`coalesce(sum(${scoped.odometer} - ${scoped.prevOdo}) filter (where ${scoped.prevOdo} is not null), 0)::int`,
      kmPerLiter: sql<string | null>`(sum(${scoped.odometer} - ${scoped.prevOdo}) filter (where ${scoped.prevOdo} is not null)
        / nullif(sum(${scoped.liters}) filter (where ${scoped.prevOdo} is not null), 0))::numeric(10,2)`,
    })
    .from(scoped)
    .innerJoin(vehicles, eq(vehicles.id, scoped.vehicleId))
    .groupBy(scoped.vehicleId, vehicles.plateNumber)
    .orderBy(sql`sum(${scoped.total}) desc`)
    .limit(50);
  res.json({ data: { totals, monthly, perVehicle } });
});

async function loadFuel(a: Access, id: string) {
  const [row] = await base().where(and(eq(fuelTransactions.id, id), fuelScope(a))).limit(1);
  if (!row) throw notFound("عملية التعبئة غير موجودة");
  return row;
}

fuelRouter.get("/fuel/:id", requirePermission("fuel.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  res.json({ data: await loadFuel(access, id) });
});

const Body = z
  .object({
    vehicleId: uuid,
    driverId: uuid.nullable().optional(),
    fueledAt: z.iso.datetime({ offset: true }),
    liters: z.coerce.number().positive().max(2000),
    pricePerLiter: z.coerce.number().min(0).max(100),
    station: optionalText(200),
    odometer: z.coerce.number().int().min(0).max(10_000_000).nullable().optional(),
    notes: optionalText(1000),
  })
  .strict();

fuelRouter.post("/fuel", requirePermission("fuel.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = Body.parse(req.body);
  const fueledAt = new Date(b.fueledAt);
  assertNotFuture(fueledAt, "وقت التعبئة");
  const created = await db.transaction(async (tx) => {
    const v = await vehicleForCreate(tx, access, b.vehicleId, "fuel.create");
    const driverId = await resolveDriver(tx, access, "fuel.create", v, b.driverId);
    if (b.odometer != null) {
      // Odometer must sit between the neighbouring fill-ups of this vehicle.
      const [bounds] = await tx
        .select({
          before: sql<number | null>`max(${fuelTransactions.odometer}) filter (where ${fuelTransactions.fueledAt} <= ${fueledAt})`,
          after: sql<number | null>`min(${fuelTransactions.odometer}) filter (where ${fuelTransactions.fueledAt} > ${fueledAt})`,
        })
        .from(fuelTransactions)
        .where(eq(fuelTransactions.vehicleId, v.id));
      if (bounds?.before != null && b.odometer < Number(bounds.before)) throw badRequest(`قراءة العداد أقل من آخر تعبئة سابقة (${bounds.before})`);
      if (bounds?.after != null && b.odometer > Number(bounds.after)) throw badRequest(`قراءة العداد أكبر من تعبئة لاحقة (${bounds.after})`);
    }
    const liters = b.liters.toFixed(2);
    const price = b.pricePerLiter.toFixed(3);
    const [f] = await tx
      .insert(fuelTransactions)
      .values({
        organizationId: access.orgId,
        vehicleId: v.id,
        projectId: v.projectId,
        driverId,
        fueledAt,
        liters,
        pricePerLiter: price,
        total: sql`round(${liters}::numeric * ${price}::numeric, 2)`,
        station: b.station ?? null,
        odometer: b.odometer ?? null,
        notes: b.notes ?? null,
        createdBy: access.userId,
      })
      .returning();
    if (b.odometer != null && b.odometer > v.currentOdometer) {
      await tx.update(vehicles).set({ currentOdometer: b.odometer, updatedAt: new Date() }).where(eq(vehicles.id, v.id));
    }
    await audit(tx, req, {
      action: "FUEL_CREATED",
      entity: "fuel",
      entityId: f!.id,
      projectId: v.projectId,
      vehicleId: v.id,
      metadata: { liters: f!.liters, total: f!.total, odometer: f!.odometer },
      newValue: { liters: f!.liters, pricePerLiter: f!.pricePerLiter, total: f!.total, odometer: f!.odometer },
    });
    return f!;
  });
  res.status(201).json({ data: created });
});

fuelRouter.put("/fuel/:id/receipt", requirePermission("fuel.create"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const f = await loadFuel(access, id);
  if (f.createdBy !== access.userId && access.scopeOf("fuel.create") !== "ALL" && !access.isMemberOf(f.projectId)) throw forbidden();
  const file = await db.transaction(async (tx) => {
    const stored = await storeUpload(tx, req, access.orgId, access.userId);
    await tx.update(fuelTransactions).set({ receiptFileId: stored.id }).where(eq(fuelTransactions.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "fuel", entityId: id, projectId: f.projectId, vehicleId: f.vehicleId, metadata: { fileName: stored.originalName, kind: "fuel_receipt" } });
    return stored;
  });
  res.status(201).json({ data: { fileName: file.originalName } });
});

fuelRouter.get("/fuel/:id/receipt", requirePermission("fuel.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const f = await loadFuel(access, id);
  const [row] = await db.select({ fileId: fuelTransactions.receiptFileId }).from(fuelTransactions).where(eq(fuelTransactions.id, id));
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "fuel", entityId: id, projectId: f.projectId, vehicleId: f.vehicleId, metadata: { kind: "fuel_receipt" } });
  await sendStoredFile(db, res, row?.fileId ?? null);
});
