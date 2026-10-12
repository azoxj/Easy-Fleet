import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { handoverSessions } from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER, readJournal, runMigrations } from "../src/db/migrations.js";
import { app, createDriverUser, createProject, createUser, createVehicle, login } from "./helpers.js";

/**
 * Migration 0007 on realistic pre-0007 data: a database migrated to 0006 with sessions in every
 * state is upgraded by the migration alone (no follow-up SQL). Runs on disposable databases only.
 */
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const created: string[] = [];
const quiet = () => undefined;
const SOURCE = "migration-0007-legacy-expired";
const PAST = "now() - interval '9 days'";
const FUTURE = "now() + interval '5 days'";

async function freshDb() {
  const name = `ef_h7_${process.pid}_${created.length}_${Date.now() % 100000}`;
  await admin.query(`create database ${name}`);
  created.push(name);
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${name}`;
  return new pg.Pool({ connectionString: u.toString(), max: 3 });
}

function folder(count: number, tweak?: (sql: string) => string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ef-h7-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const j = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
  j.entries = j.entries.slice(0, count);
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(j));
  if (tweak) {
    const f = path.join(dir, `${j.entries[count - 1].tag}.sql`);
    writeFileSync(f, tweak(readFileSync(f, "utf8")));
  }
  return dir;
}

type Fixture = { ids: Record<string, string>; hashes: Record<string, string>; fileId: string };
const CASES: [string, string, string][] = [
  ["legacyExpiredHandover", "PENDING_HANDOVER", PAST],
  ["legacyExpiredReturn", "RETURN_PENDING", PAST],
  ["legacyNotExpiredHandover", "PENDING_HANDOVER", FUTURE],
  ["legacyNotExpiredReturn", "RETURN_PENDING", FUTURE],
  ["completedExpired", "RETURN_COMPLETED", PAST],
  ["closedExpired", "CLOSED", PAST],
  ["cancelledExpired", "CANCELLED", PAST],
];

/** Pre-0007 data written with raw SQL (the new columns do not exist yet). */
async function seedLegacy(pool: pg.Pool): Promise<Fixture> {
  const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].id as string;
  const org = await one(`insert into organizations (name, slug) values ('QA', 'qa-0007') returning id`);
  const user = await one(`insert into users (organization_id, email, name, password_hash) values ($1, 'qa@example.test', 'QA', 'x') returning id`, [org]);
  const project = await one(`insert into projects (organization_id, name, code) values ($1, 'P', 'P-1') returning id`, [org]);
  const ids: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const [i, [name, status, expiry]] of CASES.entries()) {
    const emp = await one(`insert into employees (organization_id, employee_number, full_name) values ($1, $2, $3) returning id`, [org, `E${i}`, `Driver ${i}`]);
    const drv = await one(`insert into drivers (organization_id, employee_id) values ($1, $2) returning id`, [org, emp]);
    const veh = await one(`insert into vehicles (organization_id, plate_number, make, model) values ($1, $2, 'M', 'X') returning id`, [org, `QA-${i}`]);
    hashes[name] = createHash("sha256").update(`raw-token-${name}`).digest("hex");
    ids[name] = await one(`insert into handover_sessions (organization_id, vehicle_id, driver_id, project_id, created_by, token_hash, status, expires_at, access_count) values ($1,$2,$3,$4,$5,$6,$7::handover_status,${expiry},3) returning id`, [org, veh, drv, project, user, hashes[name], status]);
  }
  const fileId = await one(`insert into files (organization_id, storage_key, original_name, mime_type, size_bytes, sha256) values ($1, 'k', 'f.jpg', 'image/jpeg', 1, 'abc') returning id`, [org]);
  await pool.query(`insert into handover_photos (organization_id, session_id, phase, category, file_id) values ($1, $2, 'HANDOVER', 'FRONT', $3)`, [org, ids.legacyExpiredHandover!, fileId]);
  return { ids, hashes, fileId };
}

const sessions = async (pool: pg.Pool) => (await pool.query(`select * from handover_sessions order by token_hash`)).rows as Record<string, unknown>[];
const NEW_COLS = ["link_status", "link_created_at", "link_rotated_at", "link_rotated_by", "link_revoked_at", "link_revoked_by"];
const stripNew = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_COLS.includes(k)));
const columnExists = async (pool: pg.Pool, c: string) => (await pool.query(`select 1 from information_schema.columns where table_name='handover_sessions' and column_name=$1`, [c])).rowCount === 1;

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe("Migration 0007 — self-contained upgrade of legacy handover links", () => {
  it("closes legacy expired links, keeps everything else active, touches nothing else, audits, and leaks no token", async () => {
    const pool = await freshDb();
    const notices: string[] = [];
    pool.on("connect", (c) => c.on("notice", (n) => notices.push(String(n.message))));
    await migrate(drizzle(pool), { migrationsFolder: folder(7) }); // production today: 0000 → 0006
    const fx = await seedLegacy(pool);
    expect(await columnExists(pool, "link_status")).toBe(false);
    const before = await sessions(pool);
    const photosBefore = (await pool.query(`select * from handover_photos`)).rows;
    const vehiclesBefore = (await pool.query(`select * from vehicles order by plate_number`)).rows;
    const auditBefore = Number((await pool.query(`select count(*) from audit_logs`)).rows[0].count);

    await runMigrations(pool, quiet); // the normal deploy path: nothing else is run

    const after = await sessions(pool);
    const byId = Object.fromEntries(after.map((r) => [r.id as string, r]));
    for (const [name, id] of Object.entries(fx.ids)) {
      const row = byId[id]!;
      const expired = name.startsWith("legacyExpired");
      expect(row.link_status, name).toBe(expired ? "REVOKED" : "ACTIVE");
      expect(row.link_revoked_at !== null, name).toBe(expired);
      expect(row.link_revoked_by, name).toBeNull();
      expect(row.link_created_at, name).toBeNull();
      expect(row.link_rotated_at, name).toBeNull();
    }
    // every pre-existing column is byte-for-byte identical (token_hash, vehicle, driver, status, expires_at, updated_at…)
    expect(after.map(stripNew)).toEqual(before);
    expect((await pool.query(`select * from handover_photos`)).rows).toEqual(photosBefore);
    expect((await pool.query(`select * from vehicles order by plate_number`)).rows).toEqual(vehiclesBefore);
    expect(Number((await pool.query(`select count(*) from vehicles`)).rows[0].count)).toBe(vehiclesBefore.length);

    // audit: exactly the two closed links, no user, source marker, no token or hash anywhere
    const audit = (await pool.query(`select * from audit_logs where action = 'HANDOVER_LINK_REVOKED' order by entity_id`)).rows;
    expect(Number((await pool.query(`select count(*) from audit_logs`)).rows[0].count)).toBe(auditBefore + 2);
    expect(audit.map((a) => a.entity_id).sort()).toEqual([fx.ids.legacyExpiredHandover, fx.ids.legacyExpiredReturn].sort());
    for (const a of audit) {
      expect(a.user_id).toBeNull();
      expect(a.metadata).toMatchObject({ source: SOURCE });
    }
    const leaked = JSON.stringify(audit) + notices.join("\n");
    for (const h of Object.values(fx.hashes)) expect(leaked).not.toContain(h);
    expect(leaked).not.toMatch(/raw-token/);
    expect(notices.join("\n")).toContain("2 expired legacy handover link(s) closed");
    await pool.end();
  });

  it("legacy links that were still valid become permanent: the app accepts them even after their old expires_at passes; expired ones never work", async () => {
    // main test database already runs the latest schema; legacy shape = ACTIVE + past expires_at
    const pm = await createUser(["PROJECT_MANAGER"]);
    const project = await createProject({ managerId: pm.id });
    const mk = async (token: string, v: Partial<typeof handoverSessions.$inferInsert>) => {
      const drv = await createDriverUser(project.id);
      const veh = await createVehicle(project.id);
      const [s] = await db.insert(handoverSessions).values({ organizationId: pm.orgId, vehicleId: veh.id, driverId: drv.driver.id, projectId: project.id, createdBy: pm.id, tokenHash: createHash("sha256").update(token).digest("hex"), ...v }).returning();
      return s!;
    };
    const tok = (n: string) => `${n}${"A".repeat(43 - n.length)}`;
    await mk(tok("permanent"), { expiresAt: new Date("2020-01-01T00:00:00Z"), linkStatus: "ACTIVE" }); // legacy, was valid at migration
    await mk(tok("expiredlegacy"), { expiresAt: new Date("2020-01-01T00:00:00Z"), linkStatus: "REVOKED", linkRevokedAt: new Date() }); // legacy, closed by the migration
    expect((await request(app).get(`/api/public/handover/${tok("permanent")}`)).status).toBe(200);
    expect((await request(app).get(`/api/public/handover/${tok("expiredlegacy")}`)).status).toBe(404);
  });

  it("is atomic: a failure after the data step rolls back schema, data and audit (no half state)", async () => {
    const pool = await freshDb();
    await migrate(drizzle(pool), { migrationsFolder: folder(7) });
    const fx = await seedLegacy(pool);
    const before = await sessions(pool);
    const auditBefore = Number((await pool.query(`select count(*) from audit_logs`)).rows[0].count);
    const failing = folder(8, (sql) => `${sql}\n--> statement-breakpoint\nSELECT 1/0;`);
    await expect(migrate(drizzle(pool), { migrationsFolder: failing })).rejects.toThrow();
    expect(await columnExists(pool, "link_status")).toBe(false);
    expect((await pool.query(`select 1 from pg_type where typname = 'handover_link_status'`)).rowCount).toBe(0);
    expect(await sessions(pool)).toEqual(before);
    expect(Number((await pool.query(`select count(*) from audit_logs`)).rows[0].count)).toBe(auditBefore);
    expect(Number((await pool.query(`select count(*) from drizzle.__drizzle_migrations`)).rows[0].count)).toBe(7);
    // a clean retry then succeeds
    await runMigrations(pool, quiet);
    expect((await pool.query(`select count(*) from handover_sessions where link_status = 'REVOKED'`)).rows[0].count).toBe("2");
    expect(Object.keys(fx.ids)).toHaveLength(7);
    await pool.end();
  });

  it("is idempotent: running the file again changes nothing, even after a kept link's old expires_at has passed", async () => {
    const pool = await freshDb();
    await migrate(drizzle(pool), { migrationsFolder: folder(7) });
    const fx = await seedLegacy(pool);
    await runMigrations(pool, quiet);
    // time passes: the old expiry of a permanent link is now in the past
    await pool.query(`update handover_sessions set expires_at = now() - interval '1 day' where id = $1`, [fx.ids.legacyNotExpiredHandover!]);
    const snapshot = await sessions(pool);
    const auditCount = Number((await pool.query(`select count(*) from audit_logs`)).rows[0].count);
    const sql = readJournal().find((e) => e.tag.startsWith("0007"))!.sql;
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pool.query(stmt);
    expect(await sessions(pool)).toEqual(snapshot);
    expect(Number((await pool.query(`select count(*) from audit_logs`)).rows[0].count)).toBe(auditCount);
    expect((await pool.query(`select link_status from handover_sessions where id = $1`, [fx.ids.legacyNotExpiredHandover!])).rows[0].link_status).toBe("ACTIVE");
    await pool.end();
  });

  it("an empty / session-less database migrates cleanly (nothing to close)", async () => {
    const pool = await freshDb();
    const notices: string[] = [];
    pool.on("connect", (c) => c.on("notice", (n) => notices.push(String(n.message))));
    await runMigrations(pool, quiet);
    expect(await columnExists(pool, "link_status")).toBe(true);
    expect(notices.join("\n")).toContain("0 expired legacy handover link(s) closed");
    await pool.end();
  });

  it("new, renewed, reopened and closed links behave as designed after the upgrade (API)", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const project = await createProject({ managerId: pm.id });
    const veh = await createVehicle(project.id);
    const drv = await createDriverUser(project.id);
    const c = await login(pm.email);
    const created2 = (await c.post("/api/handovers", { vehicleId: veh.id, driverId: drv.driver.id })).body.data;
    const row = async () => (await db.select().from(handoverSessions).where(eq(handoverSessions.id, created2.id)))[0]!;
    expect(await row()).toMatchObject({ linkStatus: "ACTIVE", expiresAt: null });
    const renewed = (await c.post(`/api/handovers/${created2.id}/rotate-link`)).body.data;
    expect((await row()).linkStatus).toBe("ACTIVE");
    expect((await request(app).get(`/api/public/handover/${created2.token}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/handover/${renewed.token}`)).status).toBe(200);
    await c.post(`/api/handovers/${created2.id}/revoke-link`);
    expect((await row()).linkStatus).toBe("REVOKED");
    expect((await request(app).get(`/api/public/handover/${renewed.token}`)).status).toBe(404);
  });
});
