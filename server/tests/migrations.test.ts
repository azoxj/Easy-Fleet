import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { expectedTables, MIGRATIONS_FOLDER, readJournal, runMigrations, schemaStatus } from "../src/db/migrations.js";

/**
 * Deployment safety: a brand-new PostgreSQL database, a partially migrated one and a
 * database whose tracking table would make drizzle skip a migration all end up with
 * every migration applied and every table present — without touching existing data.
 * Needs a role allowed to CREATE DATABASE (disposable databases are dropped afterwards).
 */
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const created: string[] = [];
const quiet = () => undefined;

async function freshDb(): Promise<{ url: string; pool: pg.Pool }> {
  const name = `ef_mig_${process.pid}_${created.length}_${Date.now() % 100000}`;
  await admin.query(`create database ${name}`);
  created.push(name);
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${name}`;
  return { url: u.toString(), pool: new pg.Pool({ connectionString: u.toString(), max: 3 }) };
}

/** A copy of the migrations folder whose journal stops after `count` entries. */
function partialFolder(count: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ef-mig-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const j = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
  j.entries = j.entries.slice(0, count);
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(j));
  return dir;
}

const tableExists = async (pool: pg.Pool, t: string) => (await pool.query(`select to_regclass($1) is not null as ok`, [`public.${t}`])).rows[0].ok as boolean;
const recorded = async (pool: pg.Pool) => Number((await pool.query(`select count(*) from drizzle.__drizzle_migrations`)).rows[0].count);

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe("migrations on deployment", () => {
  it("the journal lists 0000 → 0004 in order and 0004 creates rate_limits / notification_preferences", () => {
    const j = readJournal();
    expect(j.map((e) => e.tag.slice(0, 4))).toEqual(["0000", "0001", "0002", "0003", "0004"]);
    expect(j.every((e, i) => i === 0 || e.when > j[i - 1]!.when)).toBe(true);
    expect(j[4]!.sql).toContain('CREATE TABLE "rate_limits"');
    expect(j[4]!.sql).toContain('CREATE TABLE "notification_preferences"');
    expect(j[0]!.sql).toContain('CREATE TABLE "notifications"');
    expect(expectedTables()).toEqual(expect.arrayContaining(["rate_limits", "notifications", "notification_preferences", "users", "sessions", "audit_logs"]));
  });

  it("an empty database is reported as NOT migrated (the Render failure) and a fresh run applies everything", async () => {
    const { pool } = await freshDb();
    const before = await schemaStatus(pool);
    expect(before.ok).toBe(false);
    expect(before.missingTables).toContain("rate_limits");
    expect(before.unrecorded).toHaveLength(5);
    const after = await runMigrations(pool, quiet);
    expect(after).toMatchObject({ ok: true, unrecorded: [], missingTables: [] });
    expect(await recorded(pool)).toBe(5);
    for (const t of ["rate_limits", "notifications", "notification_preferences", "users", "invoices", "handover_sessions"]) expect(await tableExists(pool, t), t).toBe(true);
    // the login path's first query now works
    await pool.query(`insert into rate_limits (key, window_start, count) values ('login-ip:test', now(), 1)`);
    // idempotent: running again changes nothing
    await runMigrations(pool, quiet);
    await runMigrations(pool, quiet);
    expect(await recorded(pool)).toBe(5);
    await pool.end();
  });

  it("a database stopped at 0003 gets 0004 applied and keeps its existing data", async () => {
    const { pool } = await freshDb();
    await migrate(drizzle(pool), { migrationsFolder: partialFolder(4) });
    expect(await tableExists(pool, "rate_limits")).toBe(false);
    const org = await pool.query(`insert into organizations (name, slug) values ('شركة قائمة', 'existing') returning id`);
    await pool.query(`insert into users (organization_id, email, name, password_hash) values ($1, 'keep@example.test', 'مستخدم قائم', 'x')`, [org.rows[0].id]);
    const after = await runMigrations(pool, quiet);
    expect(after.ok).toBe(true);
    expect(await tableExists(pool, "rate_limits")).toBe(true);
    expect((await pool.query(`select email from users`)).rows).toEqual([{ email: "keep@example.test" }]);
    expect(await recorded(pool)).toBe(5);
    await pool.end();
  });

  it("repairs a migration drizzle would skip (tracking row with a newer timestamp)", async () => {
    const { pool } = await freshDb();
    await migrate(drizzle(pool), { migrationsFolder: partialFolder(4) });
    // A stray tracking row newer than 0004 makes drizzle's timestamp check skip 0004 silently.
    await pool.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('stray', $1)`, [readJournal()[4]!.when + 1]);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    expect(await tableExists(pool, "rate_limits")).toBe(false); // proves the drizzle-only failure mode
    const logs: string[] = [];
    const after = await runMigrations(pool, (m) => logs.push(m));
    expect(after.ok).toBe(true);
    expect(await tableExists(pool, "rate_limits")).toBe(true);
    expect(logs.join("\n")).toContain("0004_fleet_operations_finance_handover_gps was skipped by the migrator");
    await pool.end();
  });

  it("the migrate script (as run by db:setup / start:render) exits 0, logs no credentials, and the app becomes ready", async () => {
    const { url, pool } = await freshDb();
    const tsx = path.resolve("../node_modules/.bin/tsx");
    const env = { PATH: process.env.PATH!, DATABASE_URL: url, NODE_ENV: "test" };
    const out = execFileSync(tsx, ["src/scripts/migrate.ts"], { env, encoding: "utf8" });
    expect(out).toContain("[migrate] database is up to date");
    expect(out).toContain(`/${url.split("/").pop()}`);
    expect(out).not.toContain(new URL(url).password || "__none__");
    expect((await schemaStatus(pool)).ok).toBe(true);
    const again = execFileSync(tsx, ["src/scripts/migrate.ts"], { env, encoding: "utf8" });
    expect(again).toContain("not yet recorded: none");
    await pool.end();
  });
});
