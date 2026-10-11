import { and, desc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { integrationReviewQueue, integrationSettings } from "../../db/schema/index.js";
import { canStoreSecrets, encryptSecret } from "../../email/secret.js";
import { ctx } from "../../http/context.js";
import { badRequest, conflict, forbidden } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { paged, pagination } from "../../http/validate.js";
import { tr } from "../../i18n/index.js";
import { BRIGHT_WASHING } from "../../integrations/bright-washing.js";
import { normalizeBaseUrl } from "../../integrations/base-url.js";
import { listRuns, loadSettings, pendingReviewCount, PROVIDERS, providerConfig, reasonMessage, runSync, secretFromEnv } from "../../integrations/service.js";
import { PgRateLimiter, pgRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";

/**
 * Settings → تكامل API. Administrative only (integrations.manage with ALL scope).
 * API key and client secret are write-only: the API returns just "saved / not saved".
 */
export const integrationsRouter = Router();

const guard = requirePermission("integrations.manage");
const adminOnly = (req: Parameters<typeof ctx>[0]) => {
  const { access } = ctx(req);
  if (access.require("integrations.manage") !== "ALL") throw forbidden();
  return access;
};

const empty = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional().or(z.literal("").transform(() => null));

const Body = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: empty(z.string().trim().max(300)),
    clientId: empty(z.string().trim().max(200)),
    /** Write-only. Omitted = keep; "" or null = remove. */
    apiKey: z.string().max(2000).nullable().optional(),
    clientSecret: z.string().max(2000).nullable().optional(),
  })
  .strict();

async function view(orgId: string) {
  const row = await loadSettings(orgId, BRIGHT_WASHING);
  const state = await PROVIDERS[BRIGHT_WASHING]!.getSyncStatus(providerConfig(row));
  const [runs, pending] = await Promise.all([listRuns(orgId, BRIGHT_WASHING, 1), pendingReviewCount(orgId, BRIGHT_WASHING)]);
  return {
    provider: BRIGHT_WASHING,
    enabled: row?.enabled ?? false,
    status: !row?.enabled ? "DISABLED" : state.state,
    statusMessage: row?.enabled && state.state === "WAITING_FOR_API" ? reasonMessage(state.reason) : null,
    baseUrl: row?.baseUrl ?? null,
    clientId: row?.clientId ?? null,
    apiKeySaved: !!row?.apiKeyEnc || secretFromEnv(row),
    apiKeyFromEnv: secretFromEnv(row),
    clientSecretSaved: !!row?.clientSecretEnc,
    canStoreSecrets: canStoreSecrets(),
    lastTest: row?.lastTestAt ? { at: row.lastTestAt, status: row.lastTestStatus, message: reasonMessage(row.lastTestMessage) } : null,
    lastSyncAt: row?.lastSyncAt ?? null,
    lastRun: runs[0] ? serializeRun(runs[0]) : null,
    pendingReview: pending,
  };
}

function serializeRun(r: Awaited<ReturnType<typeof listRuns>>[number]) {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    reasonCode: r.reasonCode,
    message: reasonMessage(r.reasonCode),
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    recordsProcessed: r.recordsProcessed,
    recordsCreated: r.recordsCreated,
    recordsUpdated: r.recordsUpdated,
    recordsSkipped: r.recordsSkipped,
    errorSummary: r.errorSummary,
  };
}

integrationsRouter.get("/integrations", guard, async (req, res) => {
  const access = adminOnly(req);
  const v = await view(access.orgId);
  res.json({ data: [{ provider: v.provider, enabled: v.enabled, status: v.status }] });
});

integrationsRouter.get("/integrations/bright-washing", guard, async (req, res) => {
  res.json({ data: await view(adminOnly(req).orgId) });
});

integrationsRouter.put("/integrations/bright-washing", guard, async (req, res) => {
  const access = adminOnly(req);
  const b = Body.parse(req.body);
  const patch: Partial<typeof integrationSettings.$inferInsert> = {};
  if (b.enabled !== undefined) patch.enabled = b.enabled;
  if (b.baseUrl !== undefined) {
    if (b.baseUrl === null) patch.baseUrl = null;
    else {
      const url = normalizeBaseUrl(b.baseUrl);
      if (!url) throw badRequest(tr("عنوان API غير صالح؛ يجب أن يبدأ بـ https وألا يحتوي على بيانات اعتماد"));
      patch.baseUrl = url;
    }
  }
  if (b.clientId !== undefined) patch.clientId = b.clientId;
  const secrets: Record<string, "set" | "removed"> = {};
  for (const [field, col] of [["apiKey", "apiKeyEnc"], ["clientSecret", "clientSecretEnc"]] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (v) {
      if (!canStoreSecrets()) throw badRequest(tr("لا يمكن حفظ بيانات الاعتماد دون ضبط EMAIL_SETTINGS_KEY على الخادم"));
      patch[col] = encryptSecret(v);
      secrets[field] = "set";
    } else {
      patch[col] = null;
      secrets[field] = "removed";
    }
  }
  const before = await loadSettings(access.orgId, BRIGHT_WASHING);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(integrationSettings)
      .values({ organizationId: access.orgId, provider: BRIGHT_WASHING, ...patch, updatedBy: access.userId, updatedAt: now })
      .onConflictDoUpdate({ target: [integrationSettings.organizationId, integrationSettings.provider], set: { ...patch, updatedBy: access.userId, updatedAt: now } });
    const toggled = patch.enabled !== undefined && patch.enabled !== (before?.enabled ?? false);
    const fields = Object.keys(patch).filter((k) => !["enabled", "apiKeyEnc", "clientSecretEnc"].includes(k));
    const meta = { provider: BRIGHT_WASHING };
    if (toggled) await audit(tx, req, { action: patch.enabled ? "INTEGRATION_ENABLED" : "INTEGRATION_DISABLED", entity: "integration", entityId: access.orgId, metadata: meta });
    if (fields.length || Object.keys(secrets).length) await audit(tx, req, { action: "INTEGRATION_SETTINGS_UPDATED", entity: "integration", entityId: access.orgId, metadata: { ...meta, fields, credentials: secrets } });
  });
  res.json({ data: await view(access.orgId) });
});

const actionLimiter = new PgRateLimiter("integration-action", 10, 15 * 60_000);
const limit = pgRateLimit(actionLimiter, (r) => r.session?.userId ?? "anon");

async function requireEnabled(orgId: string) {
  const row = await loadSettings(orgId, BRIGHT_WASHING);
  if (!row?.enabled) throw conflict(tr("التكامل غير مفعّل"));
  return row;
}

integrationsRouter.post("/integrations/bright-washing/test", guard, limit, async (req, res) => {
  const access = adminOnly(req);
  const row = await requireEnabled(access.orgId);
  const r = await PROVIDERS[BRIGHT_WASHING]!.testConnection(providerConfig(row));
  const status = r.ok ? "OK" : r.state;
  const code = r.ok ? null : r.reason;
  await db.transaction(async (tx) => {
    await tx.update(integrationSettings).set({ lastTestAt: new Date(), lastTestStatus: status, lastTestMessage: code }).where(eq(integrationSettings.id, row.id));
    await audit(tx, req, { action: "INTEGRATION_TEST", entity: "integration", entityId: access.orgId, metadata: { provider: BRIGHT_WASHING, status, reason: code } });
  });
  res.json({ data: { status, message: reasonMessage(code) } });
});

integrationsRouter.post("/integrations/bright-washing/sync", guard, limit, async (req, res) => {
  const access = adminOnly(req);
  await requireEnabled(access.orgId);
  const run = await runSync(access.orgId, BRIGHT_WASHING, access.userId);
  await audit(db, req, { action: "INTEGRATION_SYNC_RUN", entity: "integration", entityId: access.orgId, metadata: { provider: BRIGHT_WASHING, runId: run.id, status: run.status, reason: run.reasonCode, recordsProcessed: run.recordsProcessed } });
  res.json({ data: serializeRun(run) });
});

integrationsRouter.get("/integrations/bright-washing/runs", guard, async (req, res) => {
  const access = adminOnly(req);
  const rows = await listRuns(access.orgId, BRIGHT_WASHING, 20);
  res.json({ data: rows.map(serializeRun) });
});

integrationsRouter.get("/integrations/bright-washing/review", guard, async (req, res) => {
  const access = adminOnly(req);
  const q = pagination.parse(req.query);
  const cond = and(eq(integrationReviewQueue.organizationId, access.orgId), eq(integrationReviewQueue.provider, BRIGHT_WASHING), eq(integrationReviewQueue.status, "PENDING"));
  const [rows, n] = await Promise.all([
    db.select({ id: integrationReviewQueue.id, externalId: integrationReviewQueue.externalId, plateRaw: integrationReviewQueue.plateRaw, reason: integrationReviewQueue.reason, createdAt: integrationReviewQueue.createdAt }).from(integrationReviewQueue).where(cond).orderBy(desc(integrationReviewQueue.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    pendingReviewCount(access.orgId, BRIGHT_WASHING),
  ]);
  res.json(paged(rows, n, q.page, q.pageSize));
});
