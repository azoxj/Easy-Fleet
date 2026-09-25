import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { schemaStatus } from "../db/migrations.js";

/**
 * Readiness probe: the database answers, every table of the Drizzle schema exists
 * (migrations applied) and the private storage directory is writable.
 * Returns booleans only — never connection strings, paths or errors.
 */
export async function readinessChecks(): Promise<{ database: boolean; schema: boolean; storage: boolean }> {
  const database = await Promise.race([
    pool.query("select 1").then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]).catch(() => false);
  const schema = database ? await schemaStatus(pool).then((s) => s.ok).catch(() => false) : false;
  let storage = false;
  try {
    const dir = path.resolve(config.STORAGE_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await access(dir, constants.W_OK);
    storage = true;
  } catch {
    storage = false;
  }
  return { database, schema, storage };
}
