import { sql } from "drizzle-orm";
import { boolean, check, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { files } from "./documents.js";
import { handoverLinkStatus, handoverPhase, handoverPhotoCategory, handoverStatus } from "./enums.js";
import { organizations } from "./organizations.js";
import { drivers } from "./people.js";
import { projects } from "./projects.js";
import { vehicles } from "./vehicles.js";

/**
 * Vehicle handover + return session. The driver reaches it through a secret
 * link (only the SHA-256 hash of the token is stored). The same link serves
 * the handover and later the return. It never expires by time: it stops working
 * when it is revoked, renewed (new token, old one dead) or the session ends.
 */
export const handoverSessions = pgTable(
  "handover_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    status: handoverStatus("status").notNull().default("PENDING_HANDOVER"),
    /** Legacy (links used to expire). Kept for history; no longer written or checked. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    linkStatus: handoverLinkStatus("link_status").notNull().default("ACTIVE"),
    /** Null on rows created before link tracking → the session's createdAt applies. */
    linkCreatedAt: timestamp("link_created_at", { withTimezone: true }),
    linkRotatedAt: timestamp("link_rotated_at", { withTimezone: true }),
    linkRotatedBy: uuid("link_rotated_by").references(() => users.id, { onDelete: "set null" }),
    linkRevokedAt: timestamp("link_revoked_at", { withTimezone: true }),
    linkRevokedBy: uuid("link_revoked_by").references(() => users.id, { onDelete: "set null" }),
    lastAccessAt: timestamp("last_access_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    handoverAt: timestamp("handover_at", { withTimezone: true }),
    handoverOdometer: integer("handover_odometer"),
    handoverNotes: text("handover_notes"),
    returnAt: timestamp("return_at", { withTimezone: true }),
    returnOdometer: integer("return_odometer"),
    returnNotes: text("return_notes"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    reviewNotes: text("review_notes"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("handover_org_status_idx").on(t.organizationId, t.status),
    index("handover_vehicle_idx").on(t.vehicleId, t.createdAt),
    index("handover_driver_idx").on(t.driverId),
    index("handover_project_idx").on(t.projectId),
    uniqueIndex("handover_one_active_per_vehicle_uq").on(t.vehicleId).where(sql`${t.status} in ('PENDING_HANDOVER', 'RETURN_PENDING')`),
    uniqueIndex("handover_one_active_per_driver_uq").on(t.driverId).where(sql`${t.status} in ('PENDING_HANDOVER', 'RETURN_PENDING')`),
    check("handover_odometers_ck", sql`${t.returnOdometer} is null or ${t.handoverOdometer} is null or ${t.returnOdometer} >= ${t.handoverOdometer}`),
  ],
);

export const handoverPhotos = pgTable(
  "handover_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => handoverSessions.id, { onDelete: "cascade" }),
    phase: handoverPhase("phase").notNull(),
    category: handoverPhotoCategory("category").notNull(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    notes: text("notes"),
    damage: boolean("damage").notNull().default(false),
    /** Only stored when the device actually provided a position (never faked). */
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    accuracy: numeric("accuracy", { precision: 10, scale: 2 }),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("handover_photos_session_idx").on(t.sessionId, t.phase),
    uniqueIndex("handover_photos_slot_uq").on(t.sessionId, t.phase, t.category).where(sql`${t.category} <> 'OTHER'`),
  ],
);
