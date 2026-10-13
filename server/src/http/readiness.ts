import { pool } from "../db/client.js";
import { schemaStatus } from "../db/migrations.js";
import { isShuttingDown } from "../lib/lifecycle.js";
import { storageHealth } from "../services/storage.js";

/**
 * Readiness probe: the process is not draining, the database answers (a trivial `select 1`), every table of
 * the Drizzle schema exists (migrations applied) and the configured file storage is usable (local: writable
 * with free space; S3: HeadBucket, no object transferred). Booleans only — never connection strings, paths
 * or errors.
 *
 * It runs on every probe, so it stays cheap: the schema check reads the journal and several catalog rows, so
 * a positive answer is reused for 60 s (the schema cannot change while this process runs) and a negative one
 * for 5 s; the S3 check is cached by the provider for 30 s.
 */
let schemaCache: { at: number; ok: boolean } | null = null;

async function schemaOk(): Promise<boolean> {
  const now = Date.now();
  if (schemaCache && now - schemaCache.at < (schemaCache.ok ? 60_000 : 5_000)) return schemaCache.ok;
  const ok = await schemaStatus(pool).then((s) => s.ok).catch(() => false);
  schemaCache = { at: now, ok };
  return ok;
}

export const resetReadinessCacheForTests = () => {
  schemaCache = null;
};

export async function readinessChecks(): Promise<{ database: boolean; schema: boolean; storage: boolean; draining: boolean }> {
  if (isShuttingDown()) return { database: false, schema: false, storage: false, draining: true };
  let timer: NodeJS.Timeout | undefined;
  const database = await Promise.race([
    pool.query("select 1").then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 3000);
    }),
  ])
    .catch(() => false)
    .finally(() => clearTimeout(timer));
  const schema = database ? await schemaOk() : false;
  const storage = await storageHealth().catch(() => false);
  return { database, schema, storage, draining: false };
}
