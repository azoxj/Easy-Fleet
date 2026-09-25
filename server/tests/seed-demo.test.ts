import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";

/**
 * The DEMO seed as it runs on a Render preview: NODE_ENV=production on a fresh,
 * migrated database that already holds real data (the bootstrap admin). It must
 * refuse without the explicit opt-in, never print the password, cover every
 * workflow status, keep existing rows intact and be idempotent.
 */
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const created: string[] = [];
const tsx = path.resolve("../node_modules/.bin/tsx");
const DEMO_PASSWORD = "Seed-Test-Pass9!";

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

function runScript(script: string, env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync(tsx, [script], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}
const runSeed = (env: Record<string, string>) => runScript("src/scripts/seed-demo.ts", env);

const SNAPSHOT_TABLES = ["users", "projects", "vehicles", "employees", "drivers", "maintenance_requests", "invoices", "expenses", "fuel_transactions", "accidents", "violations", "handover_sessions", "handover_photos", "trips", "location_pings", "assignments", "notifications", "files", "vehicle_documents", "insurance_policies", "audit_logs"];

describe("DEMO seed on a production-mode database", () => {
  it("refuses without opt-in, then seeds every status once, keeps real data and never prints the password", { timeout: 180_000 }, async () => {
    const name = `ef_seed_${process.pid}_${Date.now() % 100000}`;
    await admin.query(`create database ${name}`);
    created.push(name);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
    try {
      await runMigrations(pool, () => undefined);
      const storage = mkdtempSync(path.join(tmpdir(), "ef-seed-storage-"));
      const env = { DATABASE_URL: u.toString(), NODE_ENV: "production", COOKIE_SECURE: "true", APP_ORIGINS: "https://easy-fleet-demo.example.com", STORAGE_ROOT: storage, APP_TIMEZONE: "Asia/Riyadh" };
      const count = async (sql: string) => Number((await pool.query(sql)).rows[0].n);

      const refused = runSeed(env);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("refusing to seed demo data in production");
      expect(runSeed({ ...env, ALLOW_DEMO_SEED: "true" }).code).not.toBe(0); // opt-in alone is not enough
      expect(runSeed({ ...env, DEMO_PASSWORD }).code).not.toBe(0); // password alone is not enough

      // Real (non-demo) data that must survive untouched: the bootstrap admin (as on Render) and a project.
      const boot = runScript("src/scripts/bootstrap.ts", { ...env, BOOTSTRAP_ADMIN_EMAIL: "owner@example.org", BOOTSTRAP_ADMIN_PASSWORD: "Owner-Test-Pass7" });
      expect(boot.code, boot.out).toBe(0);
      await pool.query(`insert into projects (organization_id, name, code, status) select id, 'Real project', 'REAL-1', 'ACTIVE' from organizations`);
      const ownerSql = `select password_hash, must_change_password, status from users where email = 'owner@example.org'`;
      const owner = (await pool.query(ownerSql)).rows[0];
      expect(owner.must_change_password).toBe(true);
      expect(await count(`select count(*) n from users where email like 'demo.%'`)).toBe(0);

      const first = runSeed({ ...env, ALLOW_DEMO_SEED: "true", DEMO_PASSWORD });
      expect(first.code, first.out).toBe(0);
      expect(first.out).not.toContain(DEMO_PASSWORD);
      expect(first.out).toContain("full demo company created (phase 5)");
      expect(first.out).toContain("password: the value of DEMO_PASSWORD (not printed)");
      expect(first.out).not.toMatch(/\/h\/[A-Za-z0-9_-]{20,}/); // no handover token in production logs

      const distinct = async (table: string, col = "status") => (await pool.query(`select array_agg(distinct ${col}::text order by ${col}::text) s from ${table}`)).rows[0].s as string[];
      expect(await distinct("maintenance_requests")).toEqual(["ACCEPTED", "APPROVED", "CLOSED", "INSPECTION", "IN_REPAIR", "PENDING_APPROVAL", "QUOTE_PENDING", "READY_FOR_HANDOVER", "REJECTED", "REQUESTED"]);
      expect(await distinct("invoices")).toEqual(["APPROVED", "CANCELLED", "DRAFT", "PAID", "REJECTED", "SUBMITTED", "TRANSFERRED", "TRANSFER_PENDING", "UNDER_REVIEW"]);
      expect(await distinct("accidents")).toEqual(["CLOSED", "INSURANCE", "OPEN", "REPAIR", "UNDER_REVIEW"]);
      expect(await distinct("violations")).toEqual(["CANCELLED", "DISPUTED", "OPEN", "PAID"]);
      expect(await distinct("handover_sessions")).toEqual(["CANCELLED", "CLOSED", "PENDING_HANDOVER", "RETURN_COMPLETED", "RETURN_PENDING"]);
      expect(await distinct("employees")).toEqual(expect.arrayContaining(["ACTIVE", "INACTIVE"]));
      expect(await distinct("assignments", "type")).toEqual(expect.arrayContaining(["MAINTENANCE_REQUEST", "INVOICE", "VEHICLE", "DOCUMENT", "ACCIDENT", "VIOLATION"]));
      const roles = (await pool.query(`select array_agg(distinct r.key order by r.key) s from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.email like 'demo.%@example.com'`)).rows[0].s;
      expect(roles).toEqual(["DRIVER", "FINANCE", "PROJECT_MANAGER", "SUPER_ADMIN", "TECHNICAL", "USER", "VIEWER"]);
      expect((await pool.query(`select array_agg(name order by code) s from projects where code like 'DEMO-%'`)).rows[0].s).toEqual(["مشروع الرياض (تجريبي)", "مشروع جدة (تجريبي)", "مشروع المدينة (تجريبي)", "مشروع مكة (تجريبي)"]);
      expect(await count(`select count(*) n from vehicles where plate_number like 'DEMO-%' and vin is not null and project_id is not null`)).toBeGreaterThanOrEqual(15);
      // Expiry mix: expired, expiring within 30 days and active documents all exist.
      expect(await count(`select count(*) n from vehicle_documents where expiry_date < current_date`)).toBeGreaterThan(0);
      expect(await count(`select count(*) n from vehicle_documents where expiry_date between current_date and current_date + 30`)).toBeGreaterThan(0);
      expect(await count(`select count(*) n from vehicle_documents where expiry_date > current_date + 30`)).toBeGreaterThan(0);
      // GPS stays inside Saudi Arabia.
      expect(await count(`select count(*) n from location_pings`)).toBeGreaterThan(100);
      expect(await count(`select count(*) n from location_pings where latitude not between 16 and 33 or longitude not between 34 and 56`)).toBe(0);
      // Handover photos are real PNG files in private storage.
      const photo = (await pool.query(`select f.storage_key, f.size_bytes from handover_photos p join files f on f.id = p.file_id limit 1`)).rows[0];
      const bytes = readFileSync(path.join(storage, photo.storage_key));
      expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(bytes.length).toBe(photo.size_bytes);
      expect(await count(`select count(*) n from audit_logs where metadata->>'source' = 'seed-demo'`)).toBeGreaterThan(50);
      expect((await pool.query(`select name from organizations`)).rows[0].name).toBe("Easy Fleet Demo Company");
      expect(await count(`select count(*) n from projects where code = 'REAL-1' and name = 'Real project'`)).toBe(1);
      expect((await pool.query(ownerSql)).rows[0]).toEqual(owner);

      // Second run: nothing duplicated.
      const snapshot = async () => Object.fromEntries(await Promise.all(SNAPSHOT_TABLES.map(async (t) => [t, await count(`select count(*) n from ${t}`)])));
      const before = await snapshot();
      const second = runSeed({ ...env, ALLOW_DEMO_SEED: "true", DEMO_PASSWORD });
      expect(second.code, second.out).toBe(0);
      expect(second.out.match(/skipping phase/g)).toHaveLength(5);
      expect(await snapshot()).toEqual(before);
    } finally {
      await pool.end();
    }
  });
});
