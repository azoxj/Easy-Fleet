import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncCatalog } from "../src/db/bootstrap.js";
import { runMigrations } from "../src/db/migrations.js";
import { databaseIdentity, demoSeedBlockReason } from "../src/lib/db-identity.js";
import { certify, collectPlan, evaluateGuards, type Flags, type Plan } from "../src/services/db-init.js";
import { LocalStorageProvider } from "../src/services/object-storage/local.js";

/**
 * The initialization tool of a NEW production database, on disposable local databases only. Nothing here can reach Render,
 * AWS or the development database: every scenario creates (and drops) its own database.
 */
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const tsx = path.resolve("../node_modules/.bin/tsx");
const created: string[] = [];
const q = () => (n: string) => {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${n}`;
  return u.toString();
};
const urlOf = q();
const base = `ef_init_base_${process.pid}`;

async function newDb(name?: string): Promise<{ name: string; url: string; pool: pg.Pool }> {
  const n = name ?? `ef_init_${process.pid}_${created.length}`;
  await admin.query(`create database "${n}" template "${base}"`);
  created.push(n);
  const pool = new pg.Pool({ connectionString: urlOf(n), max: 2 });
  pool.on("error", () => undefined); // the database is force-dropped at the end of the file
  return { name: n, url: urlOf(n), pool };
}

function cli(url: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(tsx, ["src/scripts/init-production-db.ts", ...args], {
    env: { PATH: process.env.PATH!, NODE_ENV: "development", DATABASE_URL: url, ...extra },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const hashOf = (out: string) => /PLAN HASH\s*:\s*([0-9a-f]{16})/.exec(out)![1]!;
const rows = async (pool: pg.Pool, t: string) => Number((await pool.query(`select count(*) as n from ${t}`)).rows[0].n);

beforeAll(async () => {
  await admin.query(`create database "${base}"`);
  created.push(base);
  const p = new pg.Pool({ connectionString: urlOf(base), max: 2 });
  await runMigrations(p, () => undefined);
  await syncCatalog(drizzle(p));
  await p.end();
});
afterAll(async () => {
  for (const n of created.reverse()) await admin.query(`drop database if exists "${n}" with (force)`);
  await admin.end();
});

/** Operational rows that are NOT in the append-only tables (so a cleanup is possible), plus a demo-looking organization and admin. */
async function dirty(pool: pg.Pool, dir: string) {
  const org = (await pool.query(`select id from organizations limit 1`)).rows[0].id as string;
  await pool.query(`update organizations set name = 'Easy Fleet Demo Company', legal_name = 'X (DEMO)', address = 'عنوان تجريبي', email = 'info@example.com'`);
  const u = (await pool.query(`insert into users (organization_id, email, name, password_hash) values ($1, 'demo.admin@example.com', 'مدير (تجريبي)', 'x') returning id`, [org])).rows[0].id as string;
  const role = (await pool.query(`select id from roles where key = 'SUPER_ADMIN' and organization_id is null`)).rows[0].id as string;
  await pool.query(`insert into user_roles (user_id, role_id) values ($1, $2)`, [u, role]);
  await pool.query(`insert into users (organization_id, email, name, password_hash) values ($1, 'real.admin@company.sa', 'Real Admin', 'hash-real')`, [org]);
  await pool.query(`insert into user_roles (user_id, role_id) select id, $1 from users where email = 'real.admin@company.sa'`, [role]);
  await pool.query(`insert into projects (organization_id, name, code) values ($1, 'مشروع الرياض (تجريبي)', 'DEMO-A')`, [org]);
  await pool.query(`insert into vehicles (organization_id, plate_number, make, model) values ($1, 'DEMO-1001', 'Toyota', 'Hilux')`, [org]);
  const key = `${org}/${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}`;
  await new LocalStorageProvider(dir).put(key, Buffer.from("demo-photo"), "image/jpeg");
  await pool.query(`insert into files (organization_id, storage_key, original_name, mime_type, size_bytes, sha256) values ($1, $2, 'demo.jpg', 'image/jpeg', 10, 'x')`, [org, key]);
  return { org, key };
}

describe("a database created by migrate + bootstrap is already clean", () => {
  it("holds only the catalog (organization, permissions, roles) and certifies as clean", async () => {
    const d = await newDb();
    const plan = await collectPlan(d.pool, databaseIdentity(d.url), { environment: "production", storageProvider: "s3" });
    expect(certify(plan)).toEqual({ pass: true, failures: [] });
    const nonEmpty = plan.tables.filter((t) => t.rows > 0).map((t) => t.name).sort();
    expect(nonEmpty).toEqual(["organizations", "permissions", "role_permissions", "roles"]);
    expect(plan.tables.filter((t) => t.action === "PROTECTED").map((t) => t.name).sort()).toEqual(["audit_logs", "maintenance_events"]);
    expect(Object.values(plan.demo).every((v) => v === 0)).toBe(true);
    expect(plan.admins).toEqual([]);
    expect((await collectPlan(d.pool, databaseIdentity(d.url), { environment: "production", storageProvider: "s3" })).hash).toBe(plan.hash); // stable fingerprint
    await d.pool.end();
  });
});

describe("the demo seed can never fill a production database", () => {
  it("refuses on a database named easyfleet_production, whatever the flags, and writes nothing", async () => {
    const d = await newDb("easyfleet_production");
    const r = spawnSync(tsx, ["src/scripts/seed-demo.ts"], {
      env: { PATH: process.env.PATH!, NODE_ENV: "production", COOKIE_SECURE: "true", APP_ORIGINS: "https://fleet.example.com", DATABASE_URL: d.url, ALLOW_DEMO_SEED: "true", DEMO_PASSWORD: "Seed-Guard-Pass9!" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("designated production database");
    expect(await rows(d.pool, "users")).toBe(0);
    expect(await rows(d.pool, "vehicles")).toBe(0);
    await d.pool.end();
  });

  it("refuses with EF_FORBID_DEMO_SEED=true on any database, even in development", async () => {
    const d = await newDb();
    const r = spawnSync(tsx, ["src/scripts/seed-demo.ts"], { env: { PATH: process.env.PATH!, NODE_ENV: "development", DATABASE_URL: d.url, EF_FORBID_DEMO_SEED: "true" }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("EF_FORBID_DEMO_SEED=true");
    expect(await rows(d.pool, "users")).toBe(0);
    await d.pool.end();
  });

  it("the guard reads the database name, not the host or the flags", () => {
    expect(demoSeedBlockReason("postgres://u:p@x.rds.amazonaws.com:5432/easyfleet_production?sslmode=require", {})).toMatch(/designated production database/);
    expect(demoSeedBlockReason("postgres://u:p@h/EasyFleet_Production", {})).toMatch(/designated/);
    expect(demoSeedBlockReason("postgres://u:p@h/easyfleet_staging", {})).toBeNull();
    expect(demoSeedBlockReason("postgres://u:p@h/anything", { EF_PRODUCTION_DB_NAMES: "anything, other" })).toMatch(/designated/);
    expect(databaseIdentity("postgres://user:secret@db.example.com:6543/app?sslmode=require")).toEqual({ host: "db.example.com", port: "6543", database: "app" });
  });

  it("nothing in the repository, the deploy files or CI runs a seed by itself", () => {
    const root = path.resolve("..");
    const read = (p: string) => readFileSync(path.join(root, p), "utf8");
    const pkgs = [read("package.json"), read("server/package.json")];
    for (const p of pkgs) {
      const scripts = (JSON.parse(p).scripts ?? {}) as Record<string, string>;
      for (const [name, cmd] of Object.entries(scripts)) {
        if (/^db:seed/.test(name)) continue; // the manual commands themselves
        expect(cmd, `script ${name}`).not.toMatch(/seed/);
      }
    }
    for (const f of ["render.yaml", "deploy/aws/deploy.sh", "deploy/aws/easy-fleet.service", "deploy/aws/easy-fleet.env.example", ".github/workflows/ci.yml", ".github/workflows/deploy-aws.yml.example"]) {
      expect(read(f), f).not.toMatch(/ALLOW_DEMO_SEED|DEMO_PASSWORD|db:seed|seed-demo/);
    }
    expect(read("deploy/aws/easy-fleet.env.example")).toMatch(/^EF_FORBID_DEMO_SEED=true$/m);
    expect(read("render.yaml")).not.toMatch(/start:render.*seed|preDeployCommand:.*seed/);
  });
});

describe("guards of the initialization tool", () => {
  const plan = (over: Partial<Plan> = {}): Plan => ({
    identity: { host: "db1.abcdef.eu-central-1.rds.amazonaws.com", port: "5432", database: "easyfleet_production" },
    environment: "production",
    designated: true,
    tables: [{ name: "projects", rows: 3, action: "CLEAN" }, { name: "audit_logs", rows: 0, action: "PROTECTED" }, { name: "files", rows: 0, action: "CLEAN" }],
    admins: [{ email: "real.admin@company.sa", name: "A" }],
    files: { rows: 0, bytes: 0, provider: "s3" },
    organization: { name: "Easy Fleet", looksDemo: false },
    demo: { users: 0, employees: 0, drivers: 0, projects: 0, vehicles: 0, vendors: 0, maintenance: 0, handovers: 0, organization: 0 },
    hash: "abc123abc123abc1",
    ...over,
  });
  const flags: Flags = { apply: true, targetDb: "easyfleet_production", planHash: "abc123abc123abc1", deleteFiles: false };
  const env = { EF_INIT_TARGET_DB: "easyfleet_production" };
  const failing = (p: Plan, f: Flags, e: Record<string, string | undefined>) => evaluateGuards(p, f, e).filter((g) => !g.ok).map((g) => g.id);

  it("passes only when every condition holds", () => {
    expect(failing(plan(), flags, env)).toEqual([]);
  });

  it.each([
    ["wrong --target-db", plan(), { ...flags, targetDb: "easyfleet_staging" }, env, "target-database"],
    ["EF_INIT_TARGET_DB missing", plan(), flags, {}, "target-database"],
    ["a Render host", plan({ identity: { host: "dpg-cabc123-a.frankfurt-postgres.render.com", port: "5432", database: "easyfleet_production" } }), flags, env, "host-not-render"],
    ["a host that is not AWS RDS", plan({ identity: { host: "db.internal.example.com", port: "5432", database: "easyfleet_production" } }), flags, env, "host-allowed"],
    ["not designated by the owner", plan({ designated: false }), flags, env, "designated"],
    ["plan hash of another report", plan(), { ...flags, planHash: "0000000000000000" }, env, "plan-hash"],
    ["rows in the append-only tables", plan({ tables: [{ name: "audit_logs", rows: 5, action: "PROTECTED" }] }), flags, env, "protected-tables-empty"],
    ["files without --delete-files", plan({ files: { rows: 2, bytes: 9, provider: "s3" } }), flags, env, "files-confirmed"],
    ["--keep-admin that is not a SUPER_ADMIN", plan(), { ...flags, keepAdmin: "someone@else.com" }, env, "kept-admin-valid"],
  ])("refuses: %s", (_n, p, f, e, expected) => {
    expect(failing(p as Plan, f as Flags, e)).toContain(expected);
  });
});

describe("running the tool (command line)", () => {
  it("report mode changes nothing, whatever the state, and an apply without the guards is refused", async () => {
    const d = await newDb();
    const dir = mkdtempSync(path.join(tmpdir(), "ef-init-files-"));
    await dirty(d.pool, dir);
    const before = (await d.pool.query(`select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text as n from information_schema.tables where table_schema='public' order by 1`)).rows;
    const r = cli(d.url, [], { STORAGE_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CLEAN CHECK: FAIL");
    expect(r.out).toMatch(/projects\s+1\s+WILL BE EMPTIED/);
    expect(r.out).toMatch(/audit_logs\s+0\s+protected append-only \(empty\)/);
    expect(r.out).toContain("STOPPED after the report");
    expect(r.out).not.toMatch(/postgres:\/\//);
    expect(r.out).not.toContain(new URL(process.env.TEST_DATABASE_URL!).password || "__none__");
    const refused = cli(d.url, ["--apply"], { STORAGE_DIR: dir });
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("REFUSED");
    const after = (await d.pool.query(`select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text as n from information_schema.tables where table_schema='public' order by 1`)).rows;
    expect(after).toEqual(before);
    await d.pool.end();
  });

  it("a Render database is refused even with every flag and the designation", async () => {
    const d = await newDb();
    const dir = mkdtempSync(path.join(tmpdir(), "ef-init-files-"));
    await dirty(d.pool, dir);
    await d.pool.query(`comment on database "${d.name}" is 'easy-fleet:allow-init'`);
    const hash = hashOf(cli(d.url, [], { STORAGE_DIR: dir }).out);
    // same database, but the allowed-host list is the default (RDS only): localhost is refused too
    const r = cli(d.url, ["--apply", `--target-db=${d.name}`, `--plan-hash=${hash}`, "--delete-files"], { EF_INIT_TARGET_DB: d.name, STORAGE_DIR: dir });
    expect(r.code).toBe(2);
    expect(r.out).toContain("host-allowed");
    expect(await rows(d.pool, "projects")).toBe(1);
    await d.pool.end();
  });

  it("with every guard satisfied it empties the operational tables, keeps the catalog and the chosen admin, deletes only the listed files, and cannot run twice", async () => {
    const d = await newDb();
    const dir = mkdtempSync(path.join(tmpdir(), "ef-init-files-"));
    const { key } = await dirty(d.pool, dir);
    const catalog = { permissions: await rows(d.pool, "permissions"), roles: await rows(d.pool, "roles"), rp: await rows(d.pool, "role_permissions") };
    const stranger = path.join(dir, "keep-me.txt"); // a file that is NOT in the files table must survive
    writeFileSync(stranger, "stay");
    await d.pool.query(`comment on database "${d.name}" is 'easy-fleet:allow-init'`);
    const env = { EF_INIT_TARGET_DB: d.name, EF_INIT_ALLOWED_HOST_SUFFIXES: "localhost", STORAGE_DIR: dir };
    const hash = hashOf(cli(d.url, [], env).out);
    const args = ["--apply", `--target-db=${d.name}`, `--plan-hash=${hash}`, "--delete-files", "--keep-admin=real.admin@company.sa", "--org-name=شركة المثال"];

    // a wrong hash is refused first
    expect(cli(d.url, args.map((a) => (a.startsWith("--plan-hash") ? "--plan-hash=ffffffffffffffff" : a)), env).code).toBe(2);
    expect(await rows(d.pool, "projects")).toBe(1);

    const r = cli(d.url, args, env);
    expect(r.out, r.out).toContain("DONE:");
    expect(r.code).toBe(0);
    expect(r.out).toContain("CLEAN CHECK after: PASS");
    expect(await rows(d.pool, "projects")).toBe(0);
    expect(await rows(d.pool, "vehicles")).toBe(0);
    expect(await rows(d.pool, "files")).toBe(0);
    expect(await rows(d.pool, "users")).toBe(1);
    expect((await d.pool.query(`select email, password_hash from users`)).rows).toEqual([{ email: "real.admin@company.sa", password_hash: "hash-real" }]);
    expect(await rows(d.pool, "user_roles")).toBe(1);
    expect({ permissions: await rows(d.pool, "permissions"), roles: await rows(d.pool, "roles"), rp: await rows(d.pool, "role_permissions") }).toEqual(catalog);
    const org = (await d.pool.query(`select name, legal_name, address, email from organizations`)).rows[0];
    expect(org).toEqual({ name: "شركة المثال", legal_name: null, address: null, email: null });
    expect(await new LocalStorageProvider(dir).stat(key)).toBeNull(); // the listed object is gone…
    expect(existsSync(stranger)).toBe(true); // …and nothing else was touched
    expect((await d.pool.query(`select count(*) as n from pg_constraint where not convalidated and connamespace = 'public'::regnamespace`)).rows[0].n).toBe("0");
    expect((await d.pool.query(`select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1`, [d.name])).rows[0].c).toBeNull();
    // the schema is intact: same tables, triggers, and the append-only protection still works
    expect((await d.pool.query(`select count(*) as n from information_schema.tables where table_schema = 'public'`)).rows[0].n).toBe("48");
    expect((await d.pool.query(`select count(*) as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname = 'audit_logs_block_mutation'`)).rows[0].n).toBe("4");
    // the designation was consumed: the same command is refused now
    const again = cli(d.url, args.map((a) => (a.startsWith("--plan-hash") ? `--plan-hash=${hashOf(cli(d.url, [], env).out)}` : a)), env);
    expect(again.code).toBe(2);
    expect(again.out).toContain("designated");
    await d.pool.end();
  });

  it("refuses to clean a database whose append-only tables hold rows, and says to recreate it", async () => {
    const d = await newDb();
    const dir = mkdtempSync(path.join(tmpdir(), "ef-init-files-"));
    await dirty(d.pool, dir);
    await d.pool.query(`insert into audit_logs (action, entity) values ('AUTH_LOGIN', 'session')`);
    await d.pool.query(`comment on database "${d.name}" is 'easy-fleet:allow-init'`);
    const env = { EF_INIT_TARGET_DB: d.name, EF_INIT_ALLOWED_HOST_SUFFIXES: "localhost", STORAGE_DIR: dir };
    const hash = hashOf(cli(d.url, [], env).out);
    const r = cli(d.url, ["--apply", `--target-db=${d.name}`, `--plan-hash=${hash}`, "--delete-files"], env);
    expect(r.code).toBe(2);
    expect(r.out).toContain("recreate the database instead");
    expect(await rows(d.pool, "projects")).toBe(1);
    await d.pool.end();
  });

  it("a clean database needs no apply: the report certifies it and the tool changes nothing", async () => {
    const d = await newDb();
    const r = cli(d.url, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("CLEAN CHECK: PASS");
    expect(r.out).toContain("Nothing to clean");
    await d.pool.end();
  });
});
