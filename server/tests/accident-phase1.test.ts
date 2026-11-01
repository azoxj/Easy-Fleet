import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSION_KEYS, ROLE_KEYS, ROLES, type Scope } from "../src/auth/permissions.js";
import { syncCatalog } from "../src/db/bootstrap.js";
import { db } from "../src/db/client.js";
import { accidents, permissions, rolePermissions, roles } from "../src/db/schema/index.js";
import { diffCatalog, renderCatalogDiff } from "../src/services/catalog-diff.js";
import { createProject, createVehicle, defaultOrgId, userAndClient } from "./helpers.js";

const NEW_PERMISSIONS = ["accidents.review.technical", "accidents.claims.manage", "accidents.assign", "accidents.close", "accidents.reopen", "accidents.documents.sensitive", "accidents.settings.manage"];
const old = JSON.parse(readFileSync(new URL("./fixtures/grants-9771a39.json", import.meta.url), "utf8")) as { permissions: string[]; roles: Record<string, Record<string, Scope>> };
const grants = (r: string) => ROLES[r as keyof typeof ROLES].grants as Record<string, Scope>;

describe("accident roles and permissions (catalog)", () => {
  it("adds exactly the six accident permissions and two roles; nothing else changes in the catalog", () => {
    expect(ALL_PERMISSION_KEYS.filter((p) => !old.permissions.includes(p)).sort()).toEqual([...NEW_PERMISSIONS].sort());
    expect(old.permissions.filter((p) => !ALL_PERMISSION_KEYS.includes(p as never))).toEqual([]);
    expect(ROLE_KEYS.filter((r) => !(r in old.roles)).sort()).toEqual(["ACCIDENT_MANAGER", "INSURANCE_OFFICER"]);
  });

  it("existing roles keep every grant they had at 9771a39: only the intended additions", () => {
    const additions: Record<string, Record<string, Scope>> = {
      PROJECT_MANAGER: { "accidents.documents.sensitive": "PROJECT" },
      TECHNICAL: { "accidents.review.technical": "PROJECT", "accidents.documents.sensitive": "PROJECT" },
    };
    for (const role of Object.keys(old.roles)) {
      if (role === "SUPER_ADMIN") continue;
      expect(grants(role), role).toEqual({ ...old.roles[role], ...(additions[role] ?? {}) });
    }
    // SUPER_ADMIN holds everything, including the new keys
    expect(Object.keys(grants("SUPER_ADMIN")).sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });

  it("ACCIDENT_MANAGER and INSURANCE_OFFICER are independent of SUPER_ADMIN and of each other's powers", () => {
    expect(grants("ACCIDENT_MANAGER")).toMatchObject({ "accidents.assign": "ALL", "accidents.close": "ALL", "accidents.reopen": "ALL", "accidents.read": "ALL" });
    expect(grants("ACCIDENT_MANAGER")["accidents.claims.manage"]).toBeUndefined();
    expect(grants("INSURANCE_OFFICER")).toMatchObject({ "accidents.claims.manage": "ALL", "accidents.read": "ALL" });
    for (const p of ["accidents.assign", "accidents.close", "accidents.reopen", "accidents.update", "accidents.create"]) expect(grants("INSURANCE_OFFICER")[p], p).toBeUndefined();
    // neither can administer users, roles or settings, or touch money
    for (const r of ["ACCIDENT_MANAGER", "INSURANCE_OFFICER"]) {
      for (const p of Object.keys(grants(r))) expect(p, `${r} ${p}`).toMatch(/^(accidents\.|dashboard\.view|projects\.read|vehicles\.read|vehicle_documents\.read|registration\.read|insurance\.read|notifications\.read|documents\.read)/);
    }
  });

  it("only SUPER_ADMIN holds accidents.settings.manage: assigning (even ALL) never lets anyone change the delay limits", () => {
    for (const r of ROLE_KEYS) expect(grants(r)["accidents.settings.manage"] !== undefined, r).toBe(r === "SUPER_ADMIN");
    expect(grants("ACCIDENT_MANAGER")["accidents.assign"]).toBe("ALL");
  });

  it("the accident roles hold no assignments.* permission, so they never get the generic assignment tracking menu entry", () => {
    for (const r of ["ACCIDENT_MANAGER", "INSURANCE_OFFICER"]) expect(Object.keys(grants(r)).filter((p) => p.startsWith("assignments.")), r).toEqual([]);
  });

  it("FINANCE and the other legacy roles gain none of the six new permissions; PM gets no close/assign/claims", () => {
    for (const r of ["FINANCE", "DRIVER", "USER", "VIEWER"]) for (const p of NEW_PERMISSIONS) expect(grants(r)[p], `${r} ${p}`).toBeUndefined();
    for (const p of ["accidents.close", "accidents.assign", "accidents.claims.manage", "accidents.reopen", "accidents.review.technical"]) expect(grants("PROJECT_MANAGER")[p], p).toBeUndefined();
  });

  it("syncCatalog is idempotent and produces the same grants twice", async () => {
    const snap = async () => (await db.select({ r: roles.key, p: permissions.key, s: rolePermissions.scope }).from(rolePermissions).innerJoin(roles, eq(roles.id, rolePermissions.roleId)).innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))).map((x) => `${x.r}|${x.p}|${x.s}`).sort();
    const before = await snap();
    await db.transaction((tx) => syncCatalog(tx));
    await db.transaction((tx) => syncCatalog(tx));
    expect(await snap()).toEqual(before);
    expect(before.some((x) => x.startsWith("ACCIDENT_MANAGER|accidents.close|ALL"))).toBe(true);
  });
});

describe("catalog preview (what bootstrap would change)", () => {
  const dbState = {
    permissions: old.permissions,
    roles: Object.entries(old.roles).map(([key, g]) => ({ key, grants: g })),
  };
  const code = { permissions: [...ALL_PERMISSION_KEYS], roles: ROLE_KEYS.map((key) => ({ key, grants: grants(key) })) };

  it("against a database at 9771a39 it lists only the additions", () => {
    const d = diffCatalog(dbState, code);
    expect(d.permissionsToAdd).toEqual([...NEW_PERMISSIONS].sort());
    expect(d.permissionsToRemove).toEqual([]);
    expect(d.roles.filter((r) => r.newRole).map((r) => r.role).sort()).toEqual(["ACCIDENT_MANAGER", "INSURANCE_OFFICER"]);
    for (const r of d.roles) {
      expect(r.removed, r.role).toEqual([]);
      expect(r.changed, r.role).toEqual([]);
    }
    expect(d.roles.find((r) => r.role === "TECHNICAL")!.added.map((a) => a.permission).sort()).toEqual(["accidents.documents.sensitive", "accidents.review.technical"]);
    expect(renderCatalogDiff(d)).toContain("[ACCIDENT_MANAGER] (new role)");
  });

  it("surfaces pending grant removals (the PROJECT_MANAGER case) instead of hiding them", () => {
    const prod = structuredClone(dbState);
    prod.roles.find((r) => r.key === "PROJECT_MANAGER")!.grants["finance.read"] = "PROJECT";
    prod.roles.find((r) => r.key === "PROJECT_MANAGER")!.grants["dashboard.view"] = "ALL";
    const pm = diffCatalog(prod, code).roles.find((r) => r.role === "PROJECT_MANAGER")!;
    expect(pm.removed).toEqual([{ permission: "finance.read", scope: "PROJECT" }]);
    expect(pm.changed).toEqual([{ permission: "dashboard.view", from: "ALL", to: old.roles.PROJECT_MANAGER!["dashboard.view"] }]);
    expect(renderCatalogDiff(diffCatalog(prod, code))).toContain("- finance.read (PROJECT)");
  });

  it("the preview script writes nothing: row counts and a deliberately missing grant stay as they were", async () => {
    const count = async () => (await db.execute(sql`select (select count(*) from permissions) p, (select count(*) from roles) r, (select count(*) from role_permissions) rp`)).rows[0] as Record<string, string>;
    const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.key, "ACCIDENT_MANAGER"), isNull(roles.organizationId)));
    const [p] = await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.key, "accidents.close"));
    await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, r!.id), eq(rolePermissions.permissionId, p!.id)));
    const before = await count();
    try {
      const out = execFileSync("npx", ["tsx", "src/scripts/preview-catalog-sync.ts"], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8" });
      expect(out).toContain("[ACCIDENT_MANAGER]");
      expect(out).toContain("+ accidents.close (ALL)");
      expect(out).toContain("nothing was written");
      expect(out).not.toContain(process.env.TEST_DATABASE_URL!);
      expect(await count()).toEqual(before);
      const [still] = await db.select().from(rolePermissions).where(and(eq(rolePermissions.roleId, r!.id), eq(rolePermissions.permissionId, p!.id)));
      expect(still).toBeUndefined();
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  }, 60_000);
});

describe("legacy accident routes cannot bypass the workflow; drafts are not open accidents", () => {
  async function seedCase(stage: "DRAFT" | "AWAITING_TECHNICAL" | null, opts: { projectId: string; vehicleId: string; createdBy: string }) {
    const [a] = await db
      .insert(accidents)
      .values({ organizationId: await defaultOrgId(), vehicleId: opts.vehicleId, projectId: opts.projectId, occurredAt: new Date(), description: "حادث اختبار", severity: "MINOR", status: stage === null || stage === "DRAFT" ? "OPEN" : "UNDER_REVIEW", workflowStage: stage, createdBy: opts.createdBy })
      .returning();
    return a!;
  }

  it("PATCH, status change and attachment upload are refused (409) for a workflow case, even for SUPER_ADMIN", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    const wf = await seedCase("AWAITING_TECHNICAL", { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    const patch = await client.patch(`/api/accidents/${wf.id}`, { description: "تعديل مباشر" });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe("WORKFLOW_CASE");
    expect((await client.post(`/api/accidents/${wf.id}/status`, { to: "CLOSED", resolution: "x" })).status).toBe(409);
    expect((await client.upload(`/api/accidents/${wf.id}/attachments?category=PHOTO`, Buffer.from("%PDF-1.4\n%%EOF\n"), "application/pdf", "post")).status).toBe(409);
    const [row] = await db.select().from(accidents).where(eq(accidents.id, wf.id));
    expect(row).toMatchObject({ status: "UNDER_REVIEW", workflowStage: "AWAITING_TECHNICAL", description: "حادث اختبار" });
    // the record offers no legacy actions
    const detail = await client.get(`/api/accidents/${wf.id}`);
    expect(detail.body.data.actions ?? []).toEqual([]);
  });

  it("a legacy accident (workflow_stage NULL) still follows the old path unchanged", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    const legacy = await seedCase(null, { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    expect((await client.patch(`/api/accidents/${legacy.id}`, { description: "تعديل قديم" })).status).toBe(200);
    expect((await client.post(`/api/accidents/${legacy.id}/status`, { to: "UNDER_REVIEW" })).body.data.status).toBe("UNDER_REVIEW");
  });

  it("drafts are excluded from the open list, project KPI, dashboard and report; legacy and submitted cases still count", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    const dashBefore = (await client.get("/api/dashboard")).body.data.accidents.open as number;
    const draft = await seedCase("DRAFT", { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    expect((await client.get("/api/dashboard")).body.data.accidents.open).toBe(dashBefore);
    const open = async () => (await client.get(`/api/accidents?open=true&projectId=${project.id}&pageSize=100`)).body.data.map((r: { id: string }) => r.id) as string[];
    expect(await open()).not.toContain(draft.id);
    const kpi = async () => (await client.get(`/api/projects/${project.id}/dashboard`)).body.data.counts.openAccidents as number;
    expect(await kpi()).toBe(0);
    await seedCase(null, { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    await seedCase("AWAITING_TECHNICAL", { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    expect(await open()).toHaveLength(2);
    expect(await kpi()).toBe(2);
    const rep = await client.get(`/api/reports/accidents?projectId=${project.id}`);
    expect(rep.status).toBe(200);
    expect(JSON.stringify(rep.body)).not.toContain(`ACC-${draft.number}"`);
    expect(JSON.stringify(rep.body)).toContain("ACC-");
    // dashboard KPI counts the two real cases, not the draft
    const dashOpen = async () => (await client.get("/api/dashboard")).body.data.accidents.open as number;
    expect(await dashOpen()).toBe(dashBefore + 2);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(accidents).where(and(eq(accidents.projectId, project.id), sql`workflow_stage is distinct from 'DRAFT' and status <> 'CLOSED'`)).then((r) => r[0]!.n)).toBe(2);
  });
});
