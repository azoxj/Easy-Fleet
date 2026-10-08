import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../db/client.js";
import { integrationReviewQueue, integrationSettings, integrationSyncRuns } from "../db/schema/index.js";
import { decryptSecret } from "../email/secret.js";
import { tr } from "../i18n/index.js";
import { BRIGHT_WASHING, brightWashingProvider } from "./bright-washing.js";
import { decideMatch, type VehicleMatcher } from "./matching.js";
import type { ProviderConfig, WaitingReason, WashProvider } from "./types.js";

export const PROVIDERS: Record<string, WashProvider> = { [BRIGHT_WASHING]: brightWashingProvider };

export const loadSettings = async (orgId: string, provider: string, d: DbOrTx = db) =>
  (await d.select().from(integrationSettings).where(and(eq(integrationSettings.organizationId, orgId), eq(integrationSettings.provider, provider))))[0] ?? null;

/** Decrypted credentials for a provider call. Server-side only. */
export function providerConfig(row: typeof integrationSettings.$inferSelect | null): ProviderConfig {
  return {
    baseUrl: row?.baseUrl ?? null,
    clientId: row?.clientId ?? null,
    apiKey: decryptSecret(row?.apiKeyEnc),
    clientSecret: decryptSecret(row?.clientSecretEnc),
  };
}

/** Human message for a machine reason code; computed on read so it follows the viewer's language. */
export function reasonMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === "NOT_CONFIGURED" || code === "ADAPTER_PENDING") return tr("بانتظار إعداد API الغسيل الساطع");
  return tr("تعذر إكمال العملية");
}

/** Records a sync attempt. Without a real adapter the run is WAITING_FOR_API — nothing is imported. */
export async function runSync(orgId: string, provider: string, userId: string | null) {
  const p = PROVIDERS[provider]!;
  const row = await loadSettings(orgId, provider);
  const [run] = await db.insert(integrationSyncRuns).values({ organizationId: orgId, provider, status: "STARTED", triggeredBy: userId }).returning();
  const out = await p.syncWashes(providerConfig(row));
  const done = new Date();
  const patch =
    out.state === "WAITING_FOR_API"
      ? { status: "WAITING_FOR_API" as const, reasonCode: out.reason }
      : out.state === "FAILED"
        ? { status: "FAILED" as const, reasonCode: "FAILED", errorSummary: out.reason.slice(0, 300) }
        : { status: "COMPLETED" as const, recordsProcessed: out.washes.length };
  const [finished] = await db.update(integrationSyncRuns).set({ ...patch, completedAt: done }).where(eq(integrationSyncRuns.id, run!.id)).returning();
  if (finished!.status === "COMPLETED") await db.update(integrationSettings).set({ lastSyncAt: done }).where(and(eq(integrationSettings.organizationId, orgId), eq(integrationSettings.provider, provider)));
  return finished!;
}

/** Puts a record whose vehicle is unknown or ambiguous in the review queue (never creates a vehicle). */
export async function matchOrQueue(
  d: DbOrTx,
  matcher: VehicleMatcher,
  rec: { organizationId: string; provider: string; syncRunId?: string | null; externalId: string; plateRaw: string | null; payload?: Record<string, unknown> },
) {
  const ids = rec.plateRaw ? await matcher.findVehicleIdsByPlate(rec.organizationId, rec.plateRaw) : [];
  const decision = decideMatch(ids);
  if (decision.kind === "REVIEW") {
    await d
      .insert(integrationReviewQueue)
      .values({ organizationId: rec.organizationId, provider: rec.provider, syncRunId: rec.syncRunId ?? null, externalId: rec.externalId, plateRaw: rec.plateRaw, reason: decision.reason, candidateVehicleIds: decision.candidates, payload: rec.payload ?? null })
      .onConflictDoNothing();
  }
  return decision;
}

export const listRuns = (orgId: string, provider: string, limit = 20) =>
  db.select().from(integrationSyncRuns).where(and(eq(integrationSyncRuns.organizationId, orgId), eq(integrationSyncRuns.provider, provider))).orderBy(desc(integrationSyncRuns.startedAt)).limit(limit);

export const pendingReviewCount = async (orgId: string, provider: string) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(integrationReviewQueue).where(and(eq(integrationReviewQueue.organizationId, orgId), eq(integrationReviewQueue.provider, provider), eq(integrationReviewQueue.status, "PENDING"))))[0]?.n ?? 0;

export type { WaitingReason };
