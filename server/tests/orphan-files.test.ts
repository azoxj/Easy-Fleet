import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { files } from "../src/db/schema/index.js";
import { runOrphanFileCleanup } from "../src/services/orphan-files.js";
import { getStorage } from "../src/services/storage.js";
import { defaultOrgId } from "./helpers.js";

/**
 * The cleanup finds "referenced" files from the database's own foreign keys, so a table created here — with a
 * foreign key to files — is protected exactly like the real ones (handover_photos, invoices, …).
 */
const ids: string[] = [];
const keys: Record<string, string> = {};
let orgId: string;

async function makeFile(name: string, ageDays: number) {
  const key = `${orgId}/${randomUUID()}`;
  await getStorage().put(key, Buffer.from(name), "text/plain");
  const [row] = await db
    .insert(files)
    .values({ organizationId: orgId, storageKey: key, originalName: `${name}.pdf`, mimeType: "application/pdf", sizeBytes: name.length, sha256: name, createdAt: new Date(Date.now() - ageDays * 86_400_000) })
    .returning();
  ids.push(row!.id);
  keys[name] = key;
  return row!;
}

beforeAll(async () => {
  orgId = await defaultOrgId();
  await db.execute(sql`create table if not exists tmp_orphan_ref (id serial primary key, file_id uuid references files(id) on delete restrict)`);
});
afterAll(async () => {
  await db.execute(sql`drop table if exists tmp_orphan_ref`);
  await db.delete(files).where(inArray(files.id, ids));
  for (const k of Object.values(keys)) await getStorage().remove(k);
});

describe("orphan file cleanup", () => {
  it("removes only old files nothing references; keeps referenced and recent ones; dry run changes nothing", async () => {
    const oldOrphan = await makeFile("old-orphan", 30);
    const oldReferenced = await makeFile("old-referenced", 30);
    const recentOrphan = await makeFile("recent-orphan", 1);
    await db.execute(sql`insert into tmp_orphan_ref (file_id) values (${oldReferenced.id}::uuid)`);

    const dry = await runOrphanFileCleanup({ days: 7, dryRun: true });
    expect(dry.candidates).toBeGreaterThanOrEqual(1);
    expect(dry.deleted).toBe(0);
    expect((await db.select().from(files).where(eq(files.id, oldOrphan.id))).length).toBe(1);

    const r = await runOrphanFileCleanup({ days: 7 });
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(files).where(eq(files.id, oldOrphan.id))).toHaveLength(0);
    expect(await getStorage().stat(keys["old-orphan"]!)).toBeNull(); // the object is gone too
    expect(await db.select().from(files).where(eq(files.id, oldReferenced.id))).toHaveLength(1);
    expect(await getStorage().stat(keys["old-referenced"]!)).not.toBeNull();
    expect(await db.select().from(files).where(eq(files.id, recentOrphan.id))).toHaveLength(1);
    expect(await getStorage().stat(keys["recent-orphan"]!)).not.toBeNull();
  });

  it("a file that becomes referenced is protected on the next run (the foreign key is the source of truth)", async () => {
    const f = await makeFile("late-referenced", 30);
    await db.execute(sql`insert into tmp_orphan_ref (file_id) values (${f.id}::uuid)`);
    await runOrphanFileCleanup({ days: 7 });
    expect(await db.select().from(files).where(eq(files.id, f.id))).toHaveLength(1);
    // and the database itself refuses to delete a referenced row, whatever the job does
    await expect(db.execute(sql`delete from files where id = ${f.id}::uuid`)).rejects.toThrow();
  });
});
