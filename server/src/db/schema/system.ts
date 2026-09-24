import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { notificationCategory } from "./enums.js";
import { users } from "./auth.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    category: notificationCategory("category").notNull().default("SYSTEM"),
    /** Prevents duplicate automatic notifications (e.g. daily expiry scans). */
    dedupeKey: text("dedupe_key"),
    title: text("title").notNull(),
    body: text("body"),
    /** In-app relative path only (validated server-side). */
    link: text("link"),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("notifications_user_dedupe_uq").on(t.userId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

/**
 * Append-only audit trail. A database trigger (see migration) rejects UPDATE
 * and DELETE on this table, so not even the application can rewrite history.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    projectId: uuid("project_id"),
    /** Vehicle this event belongs to (drives the vehicle timeline). */
    vehicleId: uuid("vehicle_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    oldValue: jsonb("old_value").$type<Record<string, unknown>>(),
    newValue: jsonb("new_value").$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_entity_idx").on(t.entity, t.entityId),
    index("audit_user_idx").on(t.userId),
    index("audit_vehicle_idx").on(t.vehicleId, t.createdAt),
  ],
);

/** Per-user opt-out of notification categories (SYSTEM cannot be disabled). */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: notificationCategory("category").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
);

/** Shared fixed-window rate-limit counters (works across multiple app instances). */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [index("rate_limits_window_idx").on(t.windowStart)],
);
