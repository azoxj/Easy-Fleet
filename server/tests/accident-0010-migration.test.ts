import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "../src/db/migrations.js";

/** Migration 0010 on a database holding real-looking legacy accidents: it must leave them exactly as they were. */
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const created: string[] = [];
const quiet = () => undefined;

async function freshDb() {
  const name = `ef_a10_${process.pid}_${created.length}_${Date.now() % 100000}`;
  await admin.query(`create database ${name}`);
  created.push(name);
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.pathname = `/${name}`;
  return new pg.Pool({ connectionString: u.toString(), max: 3 });
}

function folder(count: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ef-a10-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const j = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
  j.entries = j.entries.slice(0, count);
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(j));
  return dir;
}

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe("Migration 0010 — accident cases are additive", () => {
  it("leaves legacy accidents and attachments byte-for-byte unchanged and adds only empty structures", async () => {
    const pool = await freshDb();
    await migrate(drizzle(pool), { migrationsFolder: folder(10) }); // production today: 0000 → 0009
    const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].id as string;
    const org = await one(`insert into organizations (name, slug) values ('QA', 'qa-0010') returning id`);
    const user = await one(`insert into users (organization_id, email, name, password_hash) values ($1, 'qa@example.test', 'QA', 'x') returning id`, [org]);
    const veh = await one(`insert into vehicles (organization_id, plate_number, make, model) values ($1, 'QA-1', 'M', 'X') returning id`, [org]);
    const file = await one(`insert into files (organization_id, storage_key, original_name, mime_type, size_bytes, sha256) values ($1, 'k', 'f.jpg', 'image/jpeg', 1, 'abc') returning id`, [org]);
    for (const [i, status] of (["OPEN", "UNDER_REVIEW", "INSURANCE", "REPAIR", "CLOSED"] as const).entries()) {
      const a = await one(`insert into accidents (organization_id, vehicle_id, occurred_at, description, severity, status, created_by) values ($1,$2, now() - interval '${i + 1} days', $3, 'MODERATE', $4::accident_status, $5) returning id`, [org, veh, `legacy ${i}`, status, user]);
      await pool.query(`insert into accident_attachments (organization_id, accident_id, file_id, category) values ($1,$2,$3,'POLICE_REPORT')`, [org, a, file]);
    }
    const accidentsBefore = (await pool.query(`select * from accidents order by description`)).rows;
    const attachBefore = (await pool.query(`select * from accident_attachments order by id`)).rows;

    await runMigrations(pool, quiet);

    const strip = (r: Record<string, unknown>, cols: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k)));
    const newAcc = ["workflow_stage", "assigned_to", "assigned_at", "assignment_mode", "reported_by", "returned_to_stage", "returned_reason", "returned_at", "returned_by", "repair_decision", "repairable", "damage_description", "technical_notes", "stage_entered_at", "closed_by"];
    const after = (await pool.query(`select * from accidents order by description`)).rows;
    expect(after.map((r) => strip(r, newAcc))).toEqual(accidentsBefore);
    for (const r of after) for (const c of newAcc) expect(r[c], `${r.description}.${c}`).toBeNull();
    const attachAfter = (await pool.query(`select * from accident_attachments order by id`)).rows;
    expect(attachAfter.map((r) => strip(r, ["stage", "superseded_at"]))).toEqual(attachBefore);
    for (const r of attachAfter) expect([r.stage, r.superseded_at]).toEqual([null, null]);
    for (const t of ["accident_stage_officers", "accident_transitions", "accident_estimates", "accident_claims", "accident_settings", "accident_assignments"]) {
      expect(Number((await pool.query(`select count(*) from ${t}`)).rows[0].count), t).toBe(0);
    }
    // the legacy enum is untouched
    expect((await pool.query(`select enum_range(null::accident_status)::text as r`)).rows[0].r).toBe("{OPEN,UNDER_REVIEW,INSURANCE,REPAIR,CLOSED}");
    await pool.end();
  }, 60_000);
});
