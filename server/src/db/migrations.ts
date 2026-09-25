import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgTable } from "drizzle-orm/pg-core";
import type pg from "pg";
import * as schema from "./schema/index.js";

/** server/drizzle (works from src/db and dist/db). */
export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const LOCK_KEY = 7_311_842_901; // pg_advisory_lock key: one migration run at a time

export type JournalEntry = { idx: number; tag: string; when: number; hash: string; sql: string };

/** Journal entries in order, hashed exactly like drizzle's migrator (sha256 of the file). */
export function readJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };
  return journal.entries.map((e) => {
    const sql = readFileSync(path.join(folder, `${e.tag}.sql`), "utf8");
    return { idx: e.idx, tag: e.tag, when: e.when, sql, hash: createHash("sha256").update(sql).digest("hex") };
  });
}

/** Every table declared in the Drizzle schema — the tables the running app needs. */
export function expectedTables(): string[] {
  return Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableName(t as PgTable))
    .sort();
}

export type SchemaStatus = {
  appliedCount: number;
  /** Journal entries whose hash is not recorded in drizzle.__drizzle_migrations. */
  unrecorded: string[];
  /** Tables of the Drizzle schema missing from the database. */
  missingTables: string[];
  ok: boolean;
};

export async function schemaStatus(client: pg.Pool | pg.PoolClient, folder = MIGRATIONS_FOLDER): Promise<SchemaStatus> {
  const entries = readJournal(folder);
  const tracked = await client.query<{ exists: boolean }>(`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`);
  const applied = tracked.rows[0]?.exists ? (await client.query<{ hash: string }>(`select hash from drizzle.__drizzle_migrations`)).rows.map((r) => r.hash) : [];
  const appliedSet = new Set(applied);
  const tables = expectedTables();
  const present = await client.query<{ name: string }>(`select t as name from unnest($1::text[]) t where to_regclass('public.' || quote_ident(t)) is not null`, [tables]);
  const presentSet = new Set(present.rows.map((r) => r.name));
  const missingTables = tables.filter((t) => !presentSet.has(t));
  const unrecorded = entries.filter((e) => !appliedSet.has(e.hash)).map((e) => e.tag);
  return { appliedCount: applied.length, unrecorded, missingTables, ok: missingTables.length === 0 };
}

const ALREADY_EXISTS = new Set(["42P07", "42710", "42701", "42P06", "42723"]); // table/object/column/schema/function exists

/**
 * Brings the database to the latest schema. Safe to run on every deploy/start:
 *  1. drizzle's migrator applies pending migrations (0000 → latest) in journal order;
 *  2. any journal entry still not recorded (drizzle only compares against the newest
 *     recorded timestamp, so it can skip one) is applied in its own transaction and
 *     recorded; if its objects already exist it is rolled back untouched;
 *  3. every table of the Drizzle schema must exist, otherwise it throws.
 * Additive only — nothing is dropped or reset. Serialized with an advisory lock.
 */
export async function runMigrations(pool: pg.Pool, log: (m: string) => void = console.log, folder = MIGRATIONS_FOLDER): Promise<SchemaStatus> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    const before = await schemaStatus(client, folder);
    log(`[migrate] recorded migrations: ${before.appliedCount}; not yet recorded: ${before.unrecorded.join(", ") || "none"}`);
    await migrate(drizzle(pool), { migrationsFolder: folder });

    const mid = await schemaStatus(client, folder);
    for (const tag of mid.unrecorded) {
      const entry = readJournal(folder).find((e) => e.tag === tag)!;
      log(`[migrate] ${tag} was skipped by the migrator — applying it now`);
      try {
        await client.query("begin");
        for (const stmt of entry.sql.split("--> statement-breakpoint")) if (stmt.trim()) await client.query(stmt);
        await client.query(`insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)`, [entry.hash, entry.when]);
        await client.query("commit");
        log(`[migrate] ${tag} applied`);
      } catch (e) {
        await client.query("rollback");
        const code = (e as { code?: string }).code ?? "";
        if (!ALREADY_EXISTS.has(code)) throw e;
        log(`[migrate] ${tag}: objects already exist (applied earlier under a different hash) — left untouched`);
      }
    }

    const after = await schemaStatus(client, folder);
    if (!after.ok) {
      throw new Error(`[migrate] schema incomplete after migration — missing tables: ${after.missingTables.join(", ")}`);
    }
    log(`[migrate] database is up to date (${readJournal(folder).length} migrations, ${expectedTables().length} tables verified)`);
    return after;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** "host:port/database" for logs — never user or password. */
export function describeDatabase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
