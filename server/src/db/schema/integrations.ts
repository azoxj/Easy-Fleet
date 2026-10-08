import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { integrationReviewReason, integrationReviewStatus, integrationSyncStatus } from "./enums.js";
import { organizations } from "./organizations.js";
import { vehicles } from "./vehicles.js";

/**
 * External API integrations (Settings → تكامل API). One row per organization and
 * provider. Credentials are stored encrypted (AES-256-GCM, key from
 * EMAIL_SETTINGS_KEY — the same server-side key that protects the SMTP password) and
 * are never returned by the API. Authentication details are intentionally generic
 * (base URL, key, client id/secret): the provider's real scheme is added with its
 * official documentation.
 */
export const integrationSettings = pgTable(
  "integration_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** e.g. BRIGHT_WASHING (الغسيل الساطع). */
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    baseUrl: text("base_url"),
    clientId: text("client_id"),
    apiKeyEnc: text("api_key_enc"),
    clientSecretEnc: text("client_secret_enc"),
    /** Result of the last connection test (a short safe code/message, never a provider transcript). */
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestStatus: text("last_test_status"),
    lastTestMessage: text("last_test_message"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("integration_settings_org_provider_uq").on(t.organizationId, t.provider)],
);

/** Every synchronization attempt (manual or scheduled), including those that could not start (waiting for the API). */
export const integrationSyncRuns = pgTable(
  "integration_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: integrationSyncStatus("status").notNull().default("STARTED"),
    trigger: text("trigger").notNull().default("MANUAL"),
    /** Machine reason for WAITING_FOR_API / FAILED (e.g. NOT_CONFIGURED, ADAPTER_PENDING). */
    reasonCode: text("reason_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    recordsProcessed: integer("records_processed").notNull().default(0),
    recordsCreated: integer("records_created").notNull().default(0),
    recordsUpdated: integer("records_updated").notNull().default(0),
    recordsSkipped: integer("records_skipped").notNull().default(0),
    /** Short human summary of a failure — never credentials or a raw provider response. */
    errorSummary: text("error_summary"),
    triggeredBy: uuid("triggered_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("integration_sync_runs_org_started_idx").on(t.organizationId, t.provider, t.startedAt),
    check("integration_sync_runs_counts_ck", sql`${t.recordsProcessed} >= 0 and ${t.recordsCreated} >= 0 and ${t.recordsUpdated} >= 0 and ${t.recordsSkipped} >= 0`),
  ],
);

/**
 * Imported records that could not be tied to exactly one vehicle by plate number.
 * A vehicle is never created automatically: someone reviews each entry.
 */
export const integrationReviewQueue = pgTable(
  "integration_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    syncRunId: uuid("sync_run_id").references(() => integrationSyncRuns.id, { onDelete: "set null" }),
    /** The provider's own identifier of the record (e.g. wash operation number). */
    externalId: text("external_id").notNull(),
    plateRaw: text("plate_raw"),
    reason: integrationReviewReason("reason").notNull(),
    /** Vehicles that matched ambiguously (ids only). */
    candidateVehicleIds: jsonb("candidate_vehicle_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** The provider record as received (no credentials). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: integrationReviewStatus("status").notNull().default("PENDING"),
    resolvedVehicleId: uuid("resolved_vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("integration_review_org_status_idx").on(t.organizationId, t.provider, t.status, t.createdAt),
    // the same external record is queued once while it waits for review
    uniqueIndex("integration_review_pending_uq").on(t.organizationId, t.provider, t.externalId).where(sql`${t.status} = 'PENDING'`),
  ],
);
