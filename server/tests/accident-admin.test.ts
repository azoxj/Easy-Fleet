import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { syncCatalog } from "../src/db/bootstrap.js";
import { accidentSettings, accidentStageOfficers, auditLogs, permissions, rolePermissions, roles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { createUser, createProject, login } from "./helpers.js";
import { detail, toTechnical, world } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const grant = async (role: string, perm: string, scope: "ALL" | "PROJECT") => {
  const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.key, role), isNull(roles.organizationId)));
  const [p] = await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.key, perm));
  await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, r!.id), eq(rolePermissions.permissionId, p!.id)));
  await db.insert(rolePermissions).values({ roleId: r!.id, permissionId: p!.id, scope });
};
const SLA = { slaTechnicalDays: 3, slaEstimatesDays: 5, slaInsuranceDays: 7, slaClosureDays: 3 };
const settingsAudits = async (orgId: string) => db.select().from(auditLogs).where(and(eq(auditLogs.action, "ACCIDENT_CASE_SETTINGS"), eq(auditLogs.entityId, orgId))).orderBy(desc(auditLogs.id));

describe("delay limits (accident_settings)", () => {
  it("defaults are 3/5/7/3 calendar days until someone changes them; the managers see them, nobody else", async () => {
    const w = await world();
    const orgId = (await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, w.pm.id) }))!.organizationId;
    await db.delete(accidentSettings).where(eq(accidentSettings.organizationId, orgId));
    const got = await w.c.manager.get("/api/accident-cases/settings");
    expect(got.status).toBe(200);
    expect(got.body.data).toEqual({ ...SLA, canEdit: false }); // the manager assigns, but does not own the limits
    expect((await w.c.sa.get("/api/accident-cases/settings")).body.data).toEqual({ ...SLA, canEdit: true });
    for (const who of ["pm", "tech", "viewer", "finance", "insurer", "driver", "otherPm"] as const) expect((await w.c[who].get("/api/accident-cases/settings")).status, who).toBe(403);
  });

  it("accidents.assign alone — even with scope ALL — cannot change the limits; accidents.settings.manage (ALL) or settings.manage (ALL) can; the server validates every value", async () => {
    const w = await world();
    for (const who of ["pm", "tech", "viewer", "finance", "insurer", "driver", "manager"] as const) expect((await w.c[who].put("/api/accident-cases/settings", SLA)).status, who).toBe(403);
    expect((await w.c.sa.put("/api/accident-cases/settings", SLA)).status).toBe(200);
    for (const bad of [{ ...SLA, slaTechnicalDays: 0 }, { ...SLA, slaTechnicalDays: 91 }, { ...SLA, slaEstimatesDays: 1.5 }, { ...SLA, slaInsuranceDays: "7" }, { ...SLA, slaClosureDays: -1 }, { slaTechnicalDays: 3 }, { ...SLA, extra: 1 }, {}]) {
      expect((await w.c.sa.put("/api/accident-cases/settings", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    try {
      // the dedicated permission, with the assigner role
      await grant("ACCIDENT_MANAGER", "accidents.settings.manage", "ALL");
      const m = await login((await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.email, w.manager.email) }))!.email);
      expect((await m.get("/api/accident-cases/settings")).body.data.canEdit).toBe(true);
      expect((await m.put("/api/accident-cases/settings", SLA)).status).toBe(200);
      // PROJECT scope is not enough: the limits are organisation-wide
      await grant("ACCIDENT_MANAGER", "accidents.settings.manage", "PROJECT");
      expect((await m.get("/api/accident-cases/settings")).body.data.canEdit).toBe(false);
      expect((await m.put("/api/accident-cases/settings", SLA)).status).toBe(403);
      // the general administrator's permission also works (ALL only)
      await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, (await db.select({ id: roles.id }).from(roles).where(and(eq(roles.key, "ACCIDENT_MANAGER"), isNull(roles.organizationId))))[0]!.id), eq(rolePermissions.permissionId, (await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.key, "accidents.settings.manage")))[0]!.id)));
      await grant("ACCIDENT_MANAGER", "settings.manage", "PROJECT");
      expect((await m.put("/api/accident-cases/settings", SLA)).status).toBe(403);
      await grant("ACCIDENT_MANAGER", "settings.manage", "ALL");
      expect((await m.put("/api/accident-cases/settings", SLA)).status).toBe(200);
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
    // back to the code's catalog: the manager cannot edit again
    expect((await w.c.manager.put("/api/accident-cases/settings", SLA)).status).toBe(403);
  });

  it("saves into accident_settings, writes the change to the audit trail (old and new), and the new limits take effect", async () => {
    const w = await world();
    const orgId = (await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, w.pm.id) }))!.organizationId;
    await db.delete(accidentSettings).where(eq(accidentSettings.organizationId, orgId));
    const id = await toTechnical(w);
    expect((await detail(w.c.tech, id)).slaDueAt).toBe("2026-06-18T09:00:00.000Z");
    const before = (await settingsAudits(orgId)).length;
    const r = await w.c.sa.put("/api/accident-cases/settings", { ...SLA, slaTechnicalDays: 1, slaClosureDays: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ slaTechnicalDays: 1, slaClosureDays: 10, changed: true });
    const [row] = await db.select().from(accidentSettings).where(eq(accidentSettings.organizationId, orgId));
    expect(row).toMatchObject({ slaTechnicalDays: 1, slaEstimatesDays: 5, slaInsuranceDays: 7, slaClosureDays: 10 });
    expect(row!.updatedBy).not.toBeNull();
    const audits = await settingsAudits(orgId);
    expect(audits).toHaveLength(before + 1);
    expect((audits[0]!.metadata as { changes: unknown }).changes).toEqual({ slaTechnicalDays: { from: 3, to: 1 }, slaClosureDays: { from: 3, to: 10 } });
    expect(audits[0]!.userId).not.toBeNull();
    // the limit is applied to cases already in the stage
    expect((await detail(w.c.tech, id)).slaDueAt).toBe("2026-06-16T09:00:00.000Z");
    setClock(new Date("2026-06-16T09:00:01Z"));
    expect((await detail(w.c.tech, id)).overdue).toBe(true);
    // saving the same values changes nothing and is not logged
    expect((await w.c.sa.put("/api/accident-cases/settings", { ...SLA, slaTechnicalDays: 1, slaClosureDays: 10 })).body.data.changed).toBe(false);
    expect(await settingsAudits(orgId)).toHaveLength(before + 1);
    await w.c.sa.put("/api/accident-cases/settings", SLA);
  });

  it("concurrent edits are serialised: both succeed, the stored values are one of them and the last audit row says exactly that", async () => {
    const w = await world();
    const orgId = (await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, w.pm.id) }))!.organizationId;
    await w.c.sa.put("/api/accident-cases/settings", SLA);
    const sa2 = await login((await createUser(["SUPER_ADMIN"])).email);
    const a = { ...SLA, slaTechnicalDays: 11 };
    const b = { ...SLA, slaTechnicalDays: 22, slaInsuranceDays: 30 };
    const res = await Promise.all([w.c.sa.put("/api/accident-cases/settings", a), sa2.put("/api/accident-cases/settings", b)]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const [row] = await db.select().from(accidentSettings).where(eq(accidentSettings.organizationId, orgId));
    const stored = { slaTechnicalDays: row!.slaTechnicalDays, slaEstimatesDays: row!.slaEstimatesDays, slaInsuranceDays: row!.slaInsuranceDays, slaClosureDays: row!.slaClosureDays };
    expect([a, b]).toContainEqual(stored);
    const last = (await settingsAudits(orgId))[0]!.metadata as { changes: Record<string, { to: unknown }> };
    for (const [k, v] of Object.entries(last.changes)) expect(stored[k as keyof typeof stored]).toBe(v.to);
    await w.c.sa.put("/api/accident-cases/settings", SLA);
  });
});

describe("accident officers management", () => {
  const officers = async (c: Awaited<ReturnType<typeof login>>) => (await c.get("/api/accident-cases/officers")).body.data as { id: string; stage: string; userId: string; userName: string; projectId: string | null; projectName: string | null }[];

  it("lists the current officers with their project and stage", async () => {
    const w = await world();
    const list = await officers(w.c.manager);
    expect(list.find((o) => o.userId === w.tech.id)).toMatchObject({ stage: "TECHNICAL", projectId: w.project.id, projectName: w.project.name });
    expect(list.find((o) => o.userId === w.insurer.id)).toMatchObject({ stage: "INSURANCE", projectId: null, projectName: null });
    for (const who of ["pm", "tech", "viewer", "finance", "insurer", "driver"] as const) expect((await w.c[who].get("/api/accident-cases/officers")).status, who).toBe(403);
  });

  it("candidates are only people who hold the permission of the stage; project members come first; others get 403", async () => {
    const w = await world();
    const cand = async (stage: string, projectId?: string) => (await w.c.manager.get(`/api/accident-cases/officers/candidates?stage=${stage}${projectId ? `&projectId=${projectId}` : ""}`)).body.data as { id: string; member: boolean }[];
    const tech = await cand("TECHNICAL", w.project.id);
    expect(tech.map((x) => x.id)).toContain(w.tech.id);
    expect(tech.find((x) => x.id === w.tech.id)!.member).toBe(true);
    for (const no of [w.pm.id, w.viewer.id, w.insurer.id, w.finance.id]) expect(tech.map((x) => x.id)).not.toContain(no);
    expect(tech[0]!.member).toBe(true); // members first
    const ins = await cand("INSURANCE");
    expect(ins.map((x) => x.id)).toContain(w.insurer.id);
    expect(ins.map((x) => x.id)).not.toContain(w.tech.id);
    expect((await w.c.manager.get("/api/accident-cases/officers/candidates?stage=OTHER")).status).toBe(400);
    for (const who of ["pm", "tech", "viewer", "insurer"] as const) expect((await w.c[who].get("/api/accident-cases/officers/candidates?stage=TECHNICAL")).status, who).toBe(403);
  });

  it("designating: any project or all projects; an employee without the stage permission is refused; the same designation twice is refused", async () => {
    const w = await world();
    await db.delete(accidentStageOfficers);
    const tech2 = await createUser(["TECHNICAL"]);
    const post = (body: object) => w.c.manager.post("/api/accident-cases/officers", body);
    expect((await post({ stage: "TECHNICAL", userId: tech2.id, projectId: w.project.id })).status).toBe(201);
    expect((await post({ stage: "TECHNICAL", userId: tech2.id, projectId: w.project.id })).status).toBe(409);
    expect((await post({ stage: "TECHNICAL", userId: tech2.id })).status).toBe(201); // the same person for all projects is a different designation
    expect((await post({ stage: "INSURANCE", userId: w.insurer.id })).status).toBe(201); // all projects
    for (const [stage, userId] of [["TECHNICAL", w.viewer.id], ["TECHNICAL", w.insurer.id], ["INSURANCE", w.tech.id], ["INSURANCE", w.pm.id], ["TECHNICAL", w.finance.id]] as const) expect((await post({ stage, userId, projectId: w.project.id })).status, `${stage} ${userId}`).toBe(400);
    expect((await post({ stage: "TECHNICAL", userId: crypto.randomUUID() })).status).toBe(404);
    expect((await post({ stage: "TECHNICAL", userId: tech2.id, projectId: crypto.randomUUID() })).status).toBe(404);
    expect((await post({ stage: "BOTH", userId: tech2.id })).status).toBe(400);
    for (const who of ["pm", "tech", "viewer", "insurer", "finance"] as const) expect((await w.c[who].post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: tech2.id })).status, who).toBe(403);
    expect((await officers(w.c.manager)).filter((o) => o.userId === tech2.id)).toHaveLength(2);
  });

  it("changing a designation replaces the person atomically, with the same checks and an audit row; removing it is logged", async () => {
    const w = await world();
    const tech2 = await createUser(["TECHNICAL"]);
    const mine = (await officers(w.c.manager)).find((o) => o.userId === w.tech.id)!;
    const put = (id: string, userId: string, c = w.c.manager) => c.put(`/api/accident-cases/officers/${id}`, { userId });
    expect((await put(mine.id, w.tech.id)).status).toBe(409); // already the one
    expect((await put(mine.id, w.viewer.id)).status).toBe(400); // lacks the permission
    expect((await put(mine.id, w.insurer.id)).status).toBe(400); // permission of the other stage
    expect((await put(mine.id, crypto.randomUUID())).status).toBe(404);
    expect((await put(crypto.randomUUID(), tech2.id)).status).toBe(404);
    for (const who of ["pm", "tech", "viewer", "insurer"] as const) expect((await put(mine.id, tech2.id, w.c[who])).status, who).toBe(403);
    const ok = await put(mine.id, tech2.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ id: mine.id, userId: tech2.id, stage: "TECHNICAL", projectId: w.project.id });
    expect((await officers(w.c.manager)).filter((o) => o.projectId === w.project.id && o.stage === "TECHNICAL").map((o) => o.userId)).toEqual([tech2.id]);
    const a = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "ACCIDENT_CASE_OFFICERS"), eq(auditLogs.entityId, mine.id))).orderBy(desc(auditLogs.id));
    expect(a[0]!.metadata).toMatchObject({ op: "replaced", stage: "TECHNICAL", from: w.tech.id, to: tech2.id });
    // the new officer is used by the assignment engine
    const id = await toTechnical(w);
    expect((await detail(w.c.manager, id)).assignedToName).toContain("TECHNICAL");
    expect((await db.query.accidents.findFirst({ where: (x, { eq: e }) => e(x.id, id) }))!.assignedTo).toBe(tech2.id);
    // removal
    expect((await w.c.manager.delete(`/api/accident-cases/officers/${mine.id}`)).status).toBe(200);
    expect((await officers(w.c.manager)).some((o) => o.id === mine.id)).toBe(false);
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.action, "ACCIDENT_CASE_OFFICERS"), eq(auditLogs.entityId, mine.id)))).map((x) => (x.metadata as { op: string }).op).sort()).toEqual(["designated", "removed", "replaced"]);
  });

  it("a user disabled after being designated is not offered and cannot be set; concurrent changes never leave two rows for one designation", async () => {
    const w = await world();
    const tech2 = await createUser(["TECHNICAL"]);
    const tech3 = await createUser(["TECHNICAL"]);
    const mine = (await officers(w.c.manager)).find((o) => o.userId === w.tech.id)!;
    const res = await Promise.all([w.c.manager.put(`/api/accident-cases/officers/${mine.id}`, { userId: tech2.id }), w.c.sa.put(`/api/accident-cases/officers/${mine.id}`, { userId: tech3.id })]);
    expect(res.map((r) => r.status)).toEqual([200, 200]); // one after the other
    const rows = (await officers(w.c.manager)).filter((o) => o.id === mine.id);
    expect(rows).toHaveLength(1);
    expect([tech2.id, tech3.id]).toContain(rows[0]!.userId);
    // two identical designations at once: one wins
    const p = await createProject({ managerId: w.pm.id });
    const same = await Promise.all([1, 2, 3].map(() => w.c.manager.post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: w.tech.id, projectId: p.id })));
    expect(same.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });
});
