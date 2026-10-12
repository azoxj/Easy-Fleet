import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, handoverPhotos, handoverSessions } from "../src/db/schema/index.js";
import { createDriverUser, createProject, createUser, createVehicle } from "./helpers.js";

/**
 * The one-off script that runs AFTER Migration 0007 (server/sql/handover-0007). It is executed here
 * exactly as it is shipped, against the disposable test database — never against production.
 */
const dir = path.resolve("sql/handover-0007");
const CLOSE = readFileSync(path.join(dir, "step3-close-legacy-expired-links.sql"), "utf8");
const VERIFY = readFileSync(path.join(dir, "step4-verify.sql"), "utf8");
const PRE = readFileSync(path.join(dir, "step1-before-migration-readonly.sql"), "utf8");
const CUTOFF = "2026-10-13 09:00:00+00";
const BEFORE = new Date("2026-10-01T00:00:00Z"); // expired before the cutoff
const AFTER = new Date("2026-11-01T00:00:00Z"); // still valid at the cutoff
const SOURCE = "migration-0007-legacy-expired";

let client: pg.Client;
let pm: Awaited<ReturnType<typeof createUser>>;
let projectId: string;
const rows: Record<string, string> = {};

async function make(name: string, v: Partial<typeof handoverSessions.$inferInsert>) {
  const drv = await createDriverUser(projectId);
  const veh = await createVehicle(projectId);
  const [s] = await db
    .insert(handoverSessions)
    .values({ organizationId: pm.orgId, vehicleId: veh.id, driverId: drv.driver.id, projectId, createdBy: pm.id, tokenHash: `hash-${name}-${Math.random().toString(36).slice(2)}`, status: "PENDING_HANDOVER", expiresAt: BEFORE, ...v })
    .returning();
  rows[name] = s!.id;
  return s!;
}
const get = async (name: string) => (await db.select().from(handoverSessions).where(eq(handoverSessions.id, rows[name]!)))[0]!;
const run = async (sql: string) => (await client.query(sql)).rows[0] as Record<string, string>;

beforeAll(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  pm = await createUser(["PROJECT_MANAGER"]);
  projectId = (await createProject({ managerId: pm.id })).id;
  await make("legacyExpiredHandover", {});
  await make("legacyExpiredReturn", { status: "RETURN_PENDING" });
  await make("legacyNotExpired", { expiresAt: AFTER });
  await make("completed", { status: "RETURN_COMPLETED" });
  await make("closed", { status: "CLOSED" });
  await make("cancelled", { status: "CANCELLED" });
  await make("newLink", { expiresAt: null, linkCreatedAt: new Date("2026-10-14T00:00:00Z") });
  await make("newLinkWithOldExpiry", { linkCreatedAt: new Date("2026-10-14T00:00:00Z") });
  await make("renewedAfterMigration", { linkRotatedAt: new Date("2026-10-14T00:00:00Z"), linkRotatedBy: pm.id });
  const manual = new Date("2026-10-14T01:00:00Z");
  await make("revokedByHand", { linkStatus: "REVOKED", linkRevokedAt: manual, linkRevokedBy: pm.id });
});
afterAll(async () => {
  await client.end();
});

describe("Migration 0007 follow-up script: close legacy links that were already expired", () => {
  it("files contain no psql meta-commands (they run in any SQL console) and the pre-check is read-only", () => {
    for (const f of [CLOSE, VERIFY, PRE]) expect(f).not.toMatch(/^\s*\\/m);
    expect(PRE).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/im);
    expect(PRE).not.toContain("token_hash");
  });

  it("refuses to run without a cutoff and changes nothing", async () => {
    await expect(client.query(CLOSE)).rejects.toThrow(/migration0007\.cutoff/);
    expect((await get("legacyExpiredHandover")).linkStatus).toBe("ACTIVE");
  });

  it("dry run (verify before closing) shows the candidates", async () => {
    await client.query(`SET migration0007.cutoff = '${CUTOFF}'`);
    const v = await run(VERIFY);
    expect(Number(v.legacy_expired_still_open)).toBeGreaterThanOrEqual(2);
  });

  it("closes only legacy, expired, active sessions — and changes only link_status / link_revoked_at", async () => {
    const before = Object.fromEntries(await Promise.all(Object.keys(rows).map(async (k) => [k, await get(k)] as const)));
    const photosBefore = (await db.select().from(handoverPhotos)).length;
    const r = await run(CLOSE);
    expect(Number(r.links_closed)).toBe(2);
    expect(Number(r.audit_rows_written)).toBe(2);
    for (const k of Object.keys(rows)) {
      const a = await get(k);
      const b = before[k]!;
      const closedNow = k === "legacyExpiredHandover" || k === "legacyExpiredReturn";
      expect(a.linkStatus, k).toBe(closedNow ? "REVOKED" : b.linkStatus);
      // everything except the two link columns is identical
      const { linkStatus: _a, linkRevokedAt: _b, ...restA } = a;
      const { linkStatus: _c, linkRevokedAt: _d, ...restB } = b;
      expect(restA, k).toEqual(restB);
      if (closedNow) {
        expect(a.linkRevokedAt).toBeTruthy();
        expect(a.linkRevokedBy).toBeNull();
        expect(a.tokenHash).toBe(b.tokenHash);
        expect(a.status).toBe(b.status);
      } else expect(a.linkRevokedAt?.getTime() ?? null, k).toBe(b.linkRevokedAt?.getTime() ?? null);
    }
    expect((await db.select().from(handoverPhotos)).length).toBe(photosBefore);
    // the hand-closed link keeps its own revoker and time
    const hand = await get("revokedByHand");
    expect(hand.linkRevokedBy).toBe(pm.id);
    expect(hand.linkRevokedAt?.toISOString()).toBe("2026-10-14T01:00:00.000Z");
  });

  it("writes one audit row per closed link (no user, source marker, no token)", async () => {
    const a = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "HANDOVER_LINK_REVOKED")));
    const mine = a.filter((x) => (x.metadata as { source?: string } | null)?.source === SOURCE);
    expect(mine.map((x) => x.entityId).sort()).toEqual([rows.legacyExpiredHandover, rows.legacyExpiredReturn].sort());
    for (const x of mine) {
      expect(x.userId).toBeNull();
      expect(x.entity).toBe("handover");
      expect(x.metadata).toMatchObject({ source: SOURCE });
      expect(JSON.stringify(x)).not.toMatch(/hash-/);
    }
  });

  it("is idempotent: a second run closes nothing and adds no audit rows", async () => {
    const r = await run(CLOSE);
    expect(Number(r.links_closed)).toBe(0);
    expect(Number(r.audit_rows_written)).toBe(0);
    const mine = (await db.select().from(auditLogs).where(eq(auditLogs.action, "HANDOVER_LINK_REVOKED"))).filter((x) => (x.metadata as { source?: string } | null)?.source === SOURCE);
    expect(mine).toHaveLength(2);
  });

  it("verification query: nothing legacy-expired left open, nothing new or finished touched", async () => {
    const v = await run(VERIFY);
    expect(Number(v.legacy_expired_still_open)).toBe(0);
    expect(Number(v.closed_by_script)).toBe(2);
    expect(Number(v.closed_and_revoked)).toBe(2);
    expect(Number(v.new_links_touched)).toBe(0);
    expect(Number(v.not_expired_but_closed)).toBe(0);
    expect(Number(v.finished_sessions_touched)).toBe(0);
    expect(Number(v.legacy_not_expired_left_open)).toBeGreaterThanOrEqual(1);
    // the intentionally untouched ones
    expect((await get("legacyNotExpired")).linkStatus).toBe("ACTIVE");
    expect((await get("newLink")).linkStatus).toBe("ACTIVE");
    expect((await get("newLinkWithOldExpiry")).linkStatus).toBe("ACTIVE");
    expect((await get("renewedAfterMigration")).linkStatus).toBe("ACTIVE");
  });

  it("the pre-migration read-only query lists the sessions without tokens", async () => {
    const res = await client.query(PRE.split(";").filter((s) => /FROM handover_sessions/.test(s)).map((s) => s.replace(/--.*$/gm, "").trim())[0]!);
    expect(Object.keys(res.rows[0] ?? { id: 1 })).not.toContain("token_hash");
  });
});
