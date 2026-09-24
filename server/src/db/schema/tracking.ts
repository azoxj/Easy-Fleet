import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, numeric, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tripStatus, trackingSource } from "./enums.js";
import { organizations } from "./organizations.js";
import { drivers } from "./people.js";
import { projects } from "./projects.js";
import { vehicles } from "./vehicles.js";

/**
 * GPS V1. `source` distinguishes the web/PWA tracker from a future native
 * driver app that will post to the same API.
 */
export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    source: trackingSource("source").notNull().default("WEB"),
    status: tripStatus("status").notNull().default("ACTIVE"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    distanceMeters: numeric("distance_meters", { precision: 12, scale: 1 }).notNull().default("0"),
    pointCount: integer("point_count").notNull().default(0),
    lastPointAt: timestamp("last_point_at", { withTimezone: true }),
  },
  (t) => [
    index("trips_vehicle_idx").on(t.vehicleId, t.startedAt),
    index("trips_driver_idx").on(t.driverId, t.startedAt),
    uniqueIndex("trips_one_active_per_driver_uq").on(t.driverId).where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("trips_one_active_per_vehicle_uq").on(t.vehicleId).where(sql`${t.status} = 'ACTIVE'`),
  ],
);

export const locationPings = pgTable(
  "location_pings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    driverId: uuid("driver_id").notNull(),
    vehicleId: uuid("vehicle_id").notNull(),
    projectId: uuid("project_id"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
    accuracy: numeric("accuracy", { precision: 10, scale: 2 }),
    speed: numeric("speed", { precision: 8, scale: 2 }),
    heading: numeric("heading", { precision: 6, scale: 2 }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pings_trip_idx").on(t.tripId, t.recordedAt),
    index("pings_vehicle_idx").on(t.vehicleId, t.recordedAt),
    check("pings_geo_ck", sql`${t.latitude} between -90 and 90 and ${t.longitude} between -180 and 180`),
  ],
);

/** Latest known position per vehicle (upserted on every ping). */
export const vehicleLocations = pgTable("vehicle_locations", {
  vehicleId: uuid("vehicle_id")
    .primaryKey()
    .references(() => vehicles.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  driverId: uuid("driver_id"),
  tripId: uuid("trip_id"),
  latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
  longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
  accuracy: numeric("accuracy", { precision: 10, scale: 2 }),
  speed: numeric("speed", { precision: 8, scale: 2 }),
  heading: numeric("heading", { precision: 6, scale: 2 }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
