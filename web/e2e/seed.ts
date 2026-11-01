/**
 * Seeds a LOCAL throw-away database for the browser tests (web/e2e): migrations, catalog, one project with its people,
 * the designated officers and two projects' worth of users. Run from the server folder with DATABASE_URL pointing at it:
 *   cd server && DATABASE_URL=postgres://…/ef_e2e npx tsx ../web/e2e/seed.ts
 * It refuses anything that is not a local database named like a test/e2e one.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "";
const u = new URL(url);
if (!["localhost", "127.0.0.1"].includes(u.hostname) || !/(e2e|test)/i.test(u.pathname)) throw new Error("seed refuses to run: DATABASE_URL must be a local e2e/test database");

const pool = new pg.Pool({ connectionString: url, max: 2 });
await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
await migrate(drizzle(pool), { migrationsFolder: path.resolve("drizzle") });
await pool.end();

const { db } = await import("../../server/src/db/client.js");
const { syncCatalog } = await import("../../server/src/db/bootstrap.js");
const { accidentStageOfficers, vehicles } = await import("../../server/tests/../src/db/schema/index.js");
const h = await import("../../server/tests/helpers.js");
const { eq } = await import("drizzle-orm");
await db.transaction((tx) => syncCatalog(tx));

const pm = await h.createUser(["PROJECT_MANAGER"]);
const tech = await h.createUser(["TECHNICAL"]);
const tech2 = await h.createUser(["TECHNICAL"]);
const tech3 = await h.createUser(["TECHNICAL"]);
const viewer = await h.createUser(["VIEWER"]);
const project = await h.createProject({ managerId: pm.id, members: [tech.id, tech2.id, tech3.id, viewer.id] });
const vehicle = await h.createVehicle(project.id, { status: "ASSIGNED", plateNumber: "ABC 1234" });
const vehicle2 = await h.createVehicle(project.id, { status: "AVAILABLE", plateNumber: "XYZ 9876" });
const vehicle3 = await h.createVehicle(project.id, { status: "AVAILABLE", plateNumber: "LMN 5555" });
const drv = await h.createDriverUser(project.id);
await db.update(vehicles).set({ assignedDriverId: drv.driver.id }).where(eq(vehicles.id, vehicle.id));
const insurer = await h.createUser(["INSURANCE_OFFICER"]);
const manager = await h.createUser(["ACCIDENT_MANAGER"]);
const finance = await h.createUser(["FINANCE"]);
const sa = await h.createUser(["SUPER_ADMIN"]);
const otherPm = await h.createUser(["PROJECT_MANAGER"]);
const otherProject = await h.createProject({ managerId: otherPm.id });
const orgId = await h.defaultOrgId();
await db.insert(accidentStageOfficers).values([
  { organizationId: orgId, stage: "TECHNICAL", userId: tech.id, projectId: project.id },
  { organizationId: orgId, stage: "INSURANCE", userId: insurer.id, projectId: null },
]);
const out = { password: h.PASSWORD, users: { pm: pm.email, tech: tech.email, tech2: tech2.email, tech3: tech3.email, viewer: viewer.email, driver: drv.user.email, insurer: insurer.email, manager: manager.email, finance: finance.email, sa: sa.email, otherPm: otherPm.email }, ids: { project: project.id, otherProject: otherProject.id, vehicle: vehicle.id, vehicle2: vehicle2.id, vehicle3: vehicle3.id, techUser: tech.id, tech2User: tech2.id, tech3User: tech3.id, insurerUser: insurer.id } };
writeFileSync("/tmp/claude-0/e2e/seed.json", JSON.stringify(out, null, 2));
console.log("seeded", Object.keys(out.users).length, "users");
process.exit(0);
