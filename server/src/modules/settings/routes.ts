import { access as fsAccess, constants } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { organizations } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { optionalText, trimmed } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { jobStatus, runAllJobs } from "../../services/jobs.js";

/** Settings → Company profile and System information. */
export const settingsRouter = Router();

const SettingsSchema = z
  .object({
    currency: z.enum(["SAR", "AED", "KWD", "BHD", "QAR", "OMR", "USD"]).optional(),
    /** VAT rate used as the default on new invoices (percent). */
    vatRate: z.number().min(0).max(100).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    handoverLinkDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();

const companyView = (o: typeof organizations.$inferSelect) => ({
  name: o.name,
  legalName: o.legalName,
  taxNumber: o.taxNumber,
  crNumber: o.crNumber,
  address: o.address,
  phone: o.phone,
  email: o.email,
  settings: { currency: "SAR", vatRate: 15, fiscalYearStartMonth: 1, handoverLinkDays: config.HANDOVER_LINK_DAYS, ...(o.settings ?? {}) },
  updatedAt: o.updatedAt,
});

/** Company name/logo data is needed by every signed-in user (header, printouts). */
settingsRouter.get("/settings/company", async (req, res) => {
  const { access } = ctx(req);
  const [o] = await db.select().from(organizations).where(eq(organizations.id, access.orgId));
  if (!o) throw notFound();
  res.json({ data: companyView(o), meta: { canEdit: access.scopeOf("settings.manage") === "ALL" } });
});

const CompanyBody = z
  .object({
    name: trimmed(2, 150).optional(),
    legalName: optionalText(200),
    taxNumber: z.string().trim().regex(/^[0-9]{15}$/, "الرقم الضريبي يجب أن يكون 15 رقمًا").nullable().optional().or(z.literal("").transform(() => null)),
    crNumber: z.string().trim().regex(/^[0-9]{10}$/, "رقم السجل التجاري يجب أن يكون 10 أرقام").nullable().optional().or(z.literal("").transform(() => null)),
    address: optionalText(500),
    phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, "رقم هاتف غير صالح").nullable().optional().or(z.literal("").transform(() => null)),
    email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal("").transform(() => null)),
    settings: SettingsSchema.optional(),
  })
  .strict();

settingsRouter.put("/settings/company", requirePermission("settings.manage"), async (req, res) => {
  const { access } = ctx(req);
  if (access.require("settings.manage") !== "ALL") throw forbidden();
  const b = CompanyBody.parse(req.body);
  const [before] = await db.select().from(organizations).where(eq(organizations.id, access.orgId));
  if (!before) throw notFound();
  const { settings, ...fields } = b;
  const patch: Partial<typeof organizations.$inferInsert> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (settings) patch.settings = { ...(before.settings ?? {}), ...settings };
  const changes = diff(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  if (settings && JSON.stringify(before.settings ?? {}) !== JSON.stringify(patch.settings)) changes.settings = { from: before.settings ?? {}, to: patch.settings };
  else delete changes.settings;
  if (!Object.keys(changes).length) throw badRequest("لا يوجد تغيير");
  const updated = await db.transaction(async (tx) => {
    const [o] = await tx.update(organizations).set({ ...patch, updatedAt: new Date() }).where(eq(organizations.id, access.orgId)).returning();
    await audit(tx, req, { action: "SETTINGS_UPDATED", entity: "organization", entityId: access.orgId, metadata: { changes } });
    return o!;
  });
  res.json({ data: companyView(updated) });
});

/** Non-secret runtime information for administrators. */
settingsRouter.get("/settings/system", requirePermission("settings.manage"), async (req, res) => {
  const { access } = ctx(req);
  if (access.require("settings.manage") !== "ALL") throw forbidden();
  const started = Date.now();
  const [dbInfo] = await db.execute<{ version: string; size: string; migrations: number }>(sql`
    select current_setting('server_version') as version,
           pg_size_pretty(pg_database_size(current_database())) as size,
           (select count(*)::int from drizzle.__drizzle_migrations) as migrations`).then((r) => r.rows);
  const dbLatencyMs = Date.now() - started;
  const [counts] = await db.execute<Record<string, number>>(sql`
    select (select count(*)::int from users where organization_id = ${access.orgId}) as users,
           (select count(*)::int from vehicles where organization_id = ${access.orgId}) as vehicles,
           (select count(*)::int from projects where organization_id = ${access.orgId}) as projects,
           (select count(*)::int from files where organization_id = ${access.orgId}) as files,
           (select count(*)::int from sessions s join users u on u.id = s.user_id where u.organization_id = ${access.orgId} and s.revoked_at is null and s.expires_at > now()) as "activeSessions",
           (select count(*)::int from audit_logs where organization_id = ${access.orgId}) as "auditEntries"`).then((r) => r.rows);
  let storageWritable = false;
  try {
    await fsAccess(path.resolve(config.STORAGE_DIR), constants.W_OK);
    storageWritable = true;
  } catch {
    storageWritable = false;
  }
  res.json({
    data: {
      app: { name: "Easy Fleet", version: process.env.npm_package_version ?? "1.0.0", environment: config.NODE_ENV, node: process.version, uptimeSeconds: Math.round(process.uptime()) },
      database: { version: dbInfo?.version, size: dbInfo?.size, migrationsApplied: dbInfo?.migrations, latencyMs: dbLatencyMs },
      storage: { writable: storageWritable, maxUploadMb: config.MAX_UPLOAD_MB },
      security: { sessionIdleMinutes: config.SESSION_IDLE_MINUTES, sessionAbsoluteHours: config.SESSION_ABSOLUTE_HOURS, secureCookies: config.COOKIE_SECURE, trustProxy: config.TRUST_PROXY, allowedOrigins: config.appOrigins.length },
      business: { timezone: config.APP_TIMEZONE, handoverLinkDays: config.HANDOVER_LINK_DAYS, mapProvider: config.MAP_TILE_URL ? "proxy" : "osm" },
      jobs: { enabled: !config.DISABLE_JOBS, lastRunAt: jobStatus.lastRunAt, lastError: jobStatus.lastError, lastResult: jobStatus.lastResult },
      counts,
    },
  });
});

/** Runs the background jobs now (expiry notifications + cleanup). */
settingsRouter.post("/settings/jobs/run", requirePermission("settings.manage"), async (req, res) => {
  const { access } = ctx(req);
  if (access.require("settings.manage") !== "ALL") throw forbidden();
  const result = await runAllJobs();
  await audit(db, req, { action: "SETTINGS_UPDATED", entity: "system", metadata: { jobsRun: true, result } });
  res.json({ data: result });
});
