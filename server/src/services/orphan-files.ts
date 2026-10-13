import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { deleteStoredObject } from "./storage.js";

const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;

/** Every single-column foreign key that points at files(id), read from the catalog so new tables are covered automatically. */
async function fileReferences(): Promise<{ tbl: string; col: string }[]> {
  const r = await db.execute<{ tbl: string; col: string }>(sql`
    select cl.relname as tbl, a.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.files'::regclass and array_length(c.conkey, 1) = 1`);
  return r.rows;
}

/**
 * Removes uploaded files that NO record references (e.g. a photo that was replaced) once they are older than
 * `days`. Files kept for history (soft-deleted documents, anything still linked) are never touched: a file is a
 * candidate only when no foreign key row points at it, and the foreign keys are RESTRICT, so the database itself
 * refuses to delete a referenced row. The row goes first, then the object; a failed object delete is logged and the
 * (now invisible) object is left for a manual sweep rather than risking the other order.
 * Objects whose upload transaction rolled back have no row at all and are not found by this job.
 */
export async function runOrphanFileCleanup(opts: { days?: number; limit?: number; dryRun?: boolean } = {}): Promise<{ candidates: number; deleted: number; failed: number }> {
  const days = opts.days ?? config.ORPHAN_FILE_DAYS;
  const limit = opts.limit ?? 200;
  const refs = await fileReferences();
  const notReferenced = refs.map((r) => `not exists (select 1 from ${ident(r.tbl)} t where t.${ident(r.col)} = f.id)`).join(" and ") || "true";
  const rows = await db.execute<{ id: string; storage_key: string }>(
    sql.raw(`select f.id, f.storage_key from files f where f.created_at < now() - interval '${Math.trunc(days)} days' and ${notReferenced} order by f.created_at limit ${Math.trunc(limit)}`),
  );
  const out = { candidates: rows.rows.length, deleted: 0, failed: 0 };
  if (opts.dryRun) return out;
  for (const f of rows.rows) {
    try {
      const gone = await db.execute(sql`delete from files where id = ${f.id}::uuid returning id`);
      if (!gone.rows.length) continue;
      await deleteStoredObject(f.storage_key).catch((err: unknown) => {
        out.failed += 1;
        logger.warn("orphan file row removed but its object could not be deleted", { err, storageKey: f.storage_key });
      });
      out.deleted += 1;
    } catch (err) {
      // 23503: a reference appeared meanwhile — the database protected it.
      out.failed += 1;
      logger.warn("orphan file not removed", { err });
    }
  }
  if (out.candidates) logger.info("orphan file cleanup", out);
  return out;
}
