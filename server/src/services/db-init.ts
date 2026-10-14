import { createHash } from "node:crypto";
import type { DbIdentity } from "../lib/db-identity.js";

/**
 * Initialization of a NEW production database: certify that it holds no demo/test data, and (only when every guard
 * passes) empty the operational tables. Nothing here drops or alters a table, index, foreign key, trigger or
 * permission: it only reads, or DELETEs rows of operational tables (children before parents) and resets their counters.
 * (TRUNCATE is not usable: PostgreSQL refuses it on a table referenced by a foreign key from a table outside the
 * statement, and the append-only tables cannot be part of it.)
 *
 * The append-only tables (audit_logs, maintenance_events; a database trigger rejects UPDATE/DELETE/TRUNCATE on them)
 * can never be emptied from here. A database that already holds rows in them is not cleaned: it is recreated.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Catalog data the application needs to run (kept and re-synced from code, never truncated). */
export const PRESERVED_TABLES = ["organizations", "permissions", "role_permissions", "roles"] as const;
/** Identity / housekeeping tables: emptied by an apply, but not counted as "business data" in the certification. */
export const IDENTITY_TABLES = [
  "users", "user_roles", "sessions", "rate_limits", "password_reset_tokens", "notification_preferences", "email_log", "email_settings",
  "integration_settings", "integration_sync_runs", "integration_review_queue",
] as const;

export const DESIGNATION_COMMENT = "easy-fleet:allow-init";
const RENDER_HOST = /(^|\.)render\.com$|onrender\.com$|^dpg-/i;

export type TableAction = "PRESERVE" | "CLEAN" | "PROTECTED";
export type TablePlan = { name: string; rows: number; action: TableAction };
export type DemoMarkers = { users: number; employees: number; drivers: number; projects: number; vehicles: number; vendors: number; maintenance: number; handovers: number; organization: number };

export type Plan = {
  identity: DbIdentity;
  environment: string;
  designated: boolean;
  tables: TablePlan[];
  admins: { email: string; name: string }[];
  files: { rows: number; bytes: number; provider: string };
  organization: { name: string; looksDemo: boolean };
  demo: DemoMarkers;
  /** Fingerprint of everything above: an apply must quote the one from the report the owner approved. */
  hash: string;
};

const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;
export const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");

export async function listPublicTables(q: Sql): Promise<string[]> {
  const r = await q.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`);
  return r.rows.map((x) => x.table_name);
}

/** Tables guarded by the append-only trigger function. */
export async function listProtectedTables(q: Sql): Promise<string[]> {
  const r = await q.query<{ relname: string }>(`
    select distinct c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and p.proname = 'audit_logs_block_mutation' order by 1`);
  return r.rows.map((x) => x.relname);
}

export async function countDemoMarkers(q: Sql): Promise<DemoMarkers> {
  const tr = `'%(تجريبي)%'`;
  const r = await q.query<DemoMarkers>(`
    select
      (select count(*)::int from users where email ilike '%@example.com' or name like ${tr} or name ilike '%(demo)%') as users,
      (select count(*)::int from employees where full_name like ${tr} or full_name ilike '%(demo)%' or email ilike '%@example.com') as employees,
      (select count(*)::int from drivers d join employees e on e.id = d.employee_id where e.full_name like ${tr} or e.full_name ilike '%(demo)%' or e.email ilike '%@example.com') as drivers,
      (select count(*)::int from projects where code ilike 'DEMO%' or name like '%تجريبي%' or name ilike '%demo%') as projects,
      (select count(*)::int from vehicles where plate_number ilike 'DEMO-%') as vehicles,
      (select count(*)::int from vendors where name like '%تجريبي%' or name ilike '%(demo)%') as vendors,
      (select count(*)::int from maintenance_requests m join vehicles v on v.id = m.vehicle_id where v.plate_number ilike 'DEMO-%') as maintenance,
      (select count(*)::int from handover_sessions h join vehicles v on v.id = h.vehicle_id where v.plate_number ilike 'DEMO-%') as handovers,
      (select count(*)::int from organizations where name ilike '%demo%' or legal_name ilike '%demo%' or address like '%تجريبي%' or email ilike '%@example.com') as organization`);
  return r.rows[0]!;
}

export async function collectPlan(q: Sql, identity: DbIdentity, opts: { environment: string; storageProvider: string }): Promise<Plan> {
  const [all, protectedNames] = await Promise.all([listPublicTables(q), listProtectedTables(q)]);
  const tables: TablePlan[] = [];
  for (const name of all) {
    const rows = Number((await q.query<{ n: string }>(`select count(*) as n from ${ident(name)}`)).rows[0]!.n);
    const action: TableAction = (PRESERVED_TABLES as readonly string[]).includes(name) ? "PRESERVE" : protectedNames.includes(name) ? "PROTECTED" : "CLEAN";
    tables.push({ name, rows, action });
  }
  const comment = (await q.query<{ c: string | null }>(`select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()`)).rows[0]?.c;
  const admins = (
    await q.query<{ email: string; name: string }>(`
      select u.email, u.name from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
      where r.key = 'SUPER_ADMIN' and r.organization_id is null order by u.email`)
  ).rows;
  const f = (await q.query<{ n: string; b: string }>(`select count(*) as n, coalesce(sum(size_bytes), 0) as b from files`)).rows[0]!;
  const org = (await q.query<{ name: string }>(`select name from organizations order by created_at limit 1`)).rows[0];
  const demo = await countDemoMarkers(q);
  const plan: Omit<Plan, "hash"> = {
    identity,
    environment: opts.environment,
    designated: comment === DESIGNATION_COMMENT,
    tables,
    admins,
    files: { rows: Number(f.n), bytes: Number(f.b), provider: opts.storageProvider },
    organization: { name: org?.name ?? "", looksDemo: demo.organization > 0 },
    demo,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify({ d: identity.database, t: tables.map((t) => [t.name, t.rows]), a: admins.map((a) => a.email), f: plan.files.rows, o: plan.organization.name }))
    .digest("hex")
    .slice(0, 16);
  return { ...plan, hash };
}

export type Flags = { apply: boolean; targetDb?: string; planHash?: string; keepAdmin?: string; deleteFiles: boolean; orgName?: string };
export type Guard = { id: string; ok: boolean; why: string };

/** Every precondition of an apply. All must be ok; the report prints them so the owner sees what is missing. */
export function evaluateGuards(plan: Plan, flags: Flags, env: Record<string, string | undefined>): Guard[] {
  const suffixes = (env.EF_INIT_ALLOWED_HOST_SUFFIXES ?? ".rds.amazonaws.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = plan.identity.host.toLowerCase();
  const protectedRows = plan.tables.filter((t) => t.action === "PROTECTED" && t.rows > 0);
  const kept = flags.keepAdmin?.trim().toLowerCase();
  return [
    {
      id: "target-database",
      ok: !!flags.targetDb && flags.targetDb === plan.identity.database && env.EF_INIT_TARGET_DB === plan.identity.database,
      why: `--target-db=${plan.identity.database} AND EF_INIT_TARGET_DB=${plan.identity.database} must both name this database`,
    },
    { id: "host-not-render", ok: !RENDER_HOST.test(host), why: "the host is a Render database: Render is the legacy environment and is never initialized" },
    { id: "host-allowed", ok: suffixes.some((s) => host.endsWith(s)), why: `the host must end with one of: ${suffixes.join(", ")}` },
    { id: "designated", ok: plan.designated, why: `the database must carry the comment '${DESIGNATION_COMMENT}' (set by its owner: COMMENT ON DATABASE ... IS '${DESIGNATION_COMMENT}')` },
    { id: "plan-hash", ok: !!flags.planHash && flags.planHash === plan.hash, why: `--plan-hash must equal ${plan.hash} (the fingerprint of the report you approved; the state may have changed since)` },
    { id: "protected-tables-empty", ok: protectedRows.length === 0, why: `append-only tables hold rows (${protectedRows.map((t) => `${t.name}=${t.rows}`).join(", ")}): they cannot be emptied, recreate the database instead` },
    { id: "files-confirmed", ok: plan.files.rows === 0 || flags.deleteFiles, why: `${plan.files.rows} uploaded file row(s) exist: pass --delete-files to remove them and their objects` },
    { id: "kept-admin-valid", ok: !kept || plan.admins.some((a) => a.email.toLowerCase() === kept), why: `--keep-admin=${kept} is not an existing SUPER_ADMIN` },
  ];
}

/** True when nothing operational is left and no demo marker exists: the state a production database must be in before real data. */
export function certify(plan: Plan): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const identity = IDENTITY_TABLES as readonly string[];
  for (const t of plan.tables) if (t.action === "CLEAN" && !identity.includes(t.name) && t.rows > 0) failures.push(`${t.name}: ${t.rows} row(s)`);
  for (const [k, v] of Object.entries(plan.demo)) if (v > 0) failures.push(`demo ${k}: ${v}`);
  if (plan.files.rows > 0) failures.push(`files: ${plan.files.rows} row(s)`);
  if (plan.organization.looksDemo) failures.push(`organization "${plan.organization.name}" carries demo values`);
  return { pass: failures.length === 0, failures };
}

export type ApplyResult = { truncated: string[]; keptAdmin: string | null; fileKeys: string[]; orgNormalized: boolean };

/** Order in which tables can be emptied: a table is deleted only after every table that references it. */
export function deletionOrder(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const remaining = new Set(tables);
  const order: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((t) => !edges.some((e) => e.parent === t && e.child !== t && remaining.has(e.child)));
    if (!ready.length) throw new Error(`circular foreign keys between: ${[...remaining].join(", ")}`);
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return order;
}

/**
 * One transaction: DELETE the operational tables' rows (children before parents), reset their counters, keep the admin to
 * keep, normalise the organization, verify, commit. Any failure rolls everything back.
 */
export async function applyInit(client: Sql, plan: Plan, flags: Flags): Promise<ApplyResult> {
  const clean = plan.tables.filter((t) => t.action === "CLEAN").map((t) => t.name);
  const fileKeys = flags.deleteFiles ? (await client.query<{ storage_key: string }>(`select storage_key from files`)).rows.map((r) => r.storage_key) : [];
  const kept = flags.keepAdmin?.trim().toLowerCase() ?? null;
  await client.query("begin");
  try {
    await client.query(`set local lock_timeout = '15s'`);
    const keptId = kept ? ((await client.query<{ id: string }>(`select id from users where lower(email) = $1`, [kept])).rows[0]?.id ?? null) : null;
    if (kept && !keptId) throw new Error("the admin to keep disappeared");
    const edges = (
      await client.query<{ child: string; parent: string }>(
        `select cc.relname as child, pc.relname as parent from pg_constraint c join pg_class cc on cc.oid = c.conrelid join pg_class pc on pc.oid = c.confrelid where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
      )
    ).rows;
    for (const name of deletionOrder(clean, edges)) {
      if (keptId && name === "users") await client.query(`delete from users where id <> $1`, [keptId]);
      else if (keptId && name === "user_roles") await client.query(`delete from user_roles where user_id <> $1`, [keptId]);
      else await client.query(`delete from ${ident(name)}`);
    }
    // counters of the emptied tables start again at 1 (sequence state only; the protected tables are never touched)
    const seqs = await client.query<{ seq: string }>(
      `select quote_ident(n.nspname) || '.' || quote_ident(s.relname) as seq from pg_class s join pg_namespace n on n.oid = s.relnamespace join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i') join pg_class t on t.oid = d.refobjid
       where s.relkind = 'S' and n.nspname = 'public' and t.relname = any($1::text[])`,
      [clean],
    );
    for (const r of seqs.rows) await client.query(`select setval($1::regclass, 1, false)`, [r.seq]);
    const looksDemo = plan.organization.looksDemo;
    if (looksDemo || flags.orgName) {
      await client.query(
        `update organizations set name = $1, legal_name = case when $2::boolean then null else legal_name end, address = case when $2::boolean then null else address end, email = case when $2::boolean then null else email end, updated_at = now()`,
        [flags.orgName ?? "Easy Fleet", looksDemo],
      );
    }
    // verify before committing: nothing left in the cleaned tables (but the admin kept on purpose), every constraint valid
    for (const name of clean) {
      const n = Number((await client.query<{ n: string }>(`select count(*) as n from ${ident(name)}`)).rows[0]!.n);
      const allowed = keptId ? (name === "users" ? 1 : name === "user_roles" ? Number((await client.query<{ n: string }>(`select count(*) as n from user_roles`)).rows[0]!.n) : 0) : 0;
      if (n > allowed) throw new Error(`verification failed: ${name} still has ${n} row(s)`);
    }
    const bad = (await client.query<{ n: string }>(`select count(*) as n from pg_constraint where not convalidated and connamespace = 'public'::regnamespace`)).rows[0]!.n;
    if (Number(bad) > 0) throw new Error("verification failed: a constraint is not validated");
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
  return { truncated: clean, keptAdmin: kept, fileKeys, orgNormalized: plan.organization.looksDemo || !!flags.orgName };
}

export function parseFlags(argv: string[]): Flags {
  const val = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  return {
    apply: argv.includes("--apply"),
    targetDb: val("target-db"),
    planHash: val("plan-hash"),
    keepAdmin: val("keep-admin"),
    deleteFiles: argv.includes("--delete-files"),
    orgName: val("org-name"),
  };
}
