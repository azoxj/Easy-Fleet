import { execFileSync } from "node:child_process";
import { and, eq, isNull, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Scope } from "../src/auth/permissions.js";
import { syncCatalog } from "../src/db/bootstrap.js";
import { db } from "../src/db/client.js";
import { accidentEstimates, accidents, permissions, rolePermissions, roles } from "../src/db/schema/index.js";
import { ACCIDENT_PERMISSIONS, applyAccidentCatalogPlan, assertPlanScope, MANAGED_ROLES, planAccidentCatalog, readCatalogState } from "../src/services/accident-catalog-sync.js";
import { createDriverFor, createEmployee, createProject, createVehicle, defaultOrgId, PDF_BYTES, userAndClient } from "./helpers.js";

const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
afterAll(() => admin.end());

async function seedCase(stage: "DRAFT" | "AWAITING_TECHNICAL" | null, o: { projectId: string; vehicleId: string; createdBy: string; driverId?: string; repairCost?: string }) {
  const [a] = await db
    .insert(accidents)
    .values({ organizationId: await defaultOrgId(), vehicleId: o.vehicleId, projectId: o.projectId, driverId: o.driverId, occurredAt: new Date(), description: "حادث اختبار", severity: "MINOR", status: stage === null || stage === "DRAFT" ? "OPEN" : "UNDER_REVIEW", workflowStage: stage, repairCost: o.repairCost, createdBy: o.createdBy })
    .returning();
  return a!;
}

describe("accident_estimates.selected is a boolean and only one estimate per accident can be selected", () => {
  it("rejects a second selected estimate for the same accident, allows one per accident", async () => {
    const { user } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    const a1 = await seedCase("AWAITING_TECHNICAL", { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    const a2 = await seedCase("AWAITING_TECHNICAL", { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    const orgId = await defaultOrgId();
    const est = (accidentId: string, selected: boolean) => db.insert(accidentEstimates).values({ organizationId: orgId, accidentId, vendorName: "ورشة", amount: "100.00", selected });
    await est(a1.id, false);
    await est(a1.id, false);
    await est(a1.id, true);
    await expect(est(a1.id, true)).rejects.toThrow();
    await est(a2.id, true);
    const col = (await db.execute(sql`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'accident_estimates' and column_name = 'selected'`)).rows[0]!;
    expect(col).toMatchObject({ data_type: "boolean", is_nullable: "NO" });
    expect(String(col.column_default)).toBe("false");
  });
});

describe("legacy UPDATEs carry workflow_stage IS NULL in the statement itself", () => {
  /** Holds the accident row locked in another connection, fires the request, then moves the case into the workflow and commits. */
  async function raceInto(name: string, accidentId: string, fire: () => Promise<{ status: number; body: { error?: { code?: string } } }>) {
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("select id from accidents where id = $1 for update", [accidentId]);
      const pending = fire().then((r) => r); // supertest requests are lazy: subscribe now so the request really starts
      // Wait until the request is really blocked on the row lock (it has loaded the still-legacy row and is at its UPDATE / lock).
      let blocked = 0;
      for (let i = 0; i < 100 && !blocked; i++) {
        await new Promise((r) => setTimeout(r, 50));
        blocked = Number((await admin.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).rows[0].n);
      }
      expect(blocked, `${name}: the request must be waiting on the lock for the race to be real`).toBeGreaterThan(0);
      await c.query("update accidents set workflow_stage = 'AWAITING_TECHNICAL' where id = $1", [accidentId]);
      await c.query("commit");
      return await pending;
    } finally {
      c.release();
    }
  }

  it("PATCH, status change and attachment upload lose the race safely: 409 WORKFLOW_CASE and the row is untouched", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    for (const [name, fire] of [
      ["patch", (id: string) => () => client.patch(`/api/accidents/${id}`, { description: "تعديل متزامن" })],
      ["status", (id: string) => () => client.post(`/api/accidents/${id}/status`, { to: "UNDER_REVIEW" })],
      ["attachment", (id: string) => () => client.upload(`/api/accidents/${id}/attachments?category=PHOTO`, PDF_BYTES, "application/pdf", "post")],
    ] as const) {
      const a = await seedCase(null, { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
      const res = await raceInto(name, a.id, fire(a.id));
      expect(res.status, name).toBe(409);
      expect(res.body.error?.code, name).toBe("WORKFLOW_CASE");
      const [row] = await db.select().from(accidents).where(eq(accidents.id, a.id));
      expect(row, name).toMatchObject({ description: "حادث اختبار", status: "OPEN", workflowStage: "AWAITING_TECHNICAL" });
      expect((await db.execute(sql`select count(*)::int as n from accident_attachments where accident_id = ${a.id}`)).rows[0]!.n, name).toBe(0);
    }
  });

  it("without a race, legacy PATCH / status / attachment on a legacy case still succeed", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    const a = await seedCase(null, { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    expect((await client.patch(`/api/accidents/${a.id}`, { description: "تعديل عادي" })).status).toBe(200);
    expect((await client.upload(`/api/accidents/${a.id}/attachments?category=PHOTO`, PDF_BYTES, "application/pdf", "post")).status).toBe(201);
    expect((await client.post(`/api/accidents/${a.id}/status`, { to: "UNDER_REVIEW" })).body.data.status).toBe("UNDER_REVIEW");
    expect((await client.post(`/api/accidents/${a.id}/status`, { to: "CLOSED", resolution: "تم" })).body.data.status).toBe("CLOSED");
  });
});

describe("drafts are not counted in the driver report or the cost ledger", () => {
  it("driver accident count and ACCIDENT costs ignore drafts but keep legacy and submitted cases", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const project = await createProject();
    const vehicle = await createVehicle(project.id);
    const emp = await createEmployee(project.id);
    const drv = await createDriverFor(emp.id);
    const base = { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id, driverId: drv.id };
    const count = async () => {
      const r = await client.get(`/api/reports/drivers?projectId=${project.id}`);
      expect(r.status).toBe(200);
      return (r.body.data as { fullName: string; accidents: number }[]).find((x) => x.accidents !== undefined && x.fullName === emp.fullName)?.accidents;
    };
    const cost = async () => Number((await client.get(`/api/projects/${project.id}/dashboard`)).body.data.costs.month.ACCIDENT ?? 0);
    await seedCase("DRAFT", { ...base, repairCost: "1000.00" });
    expect(await count()).toBe(0);
    expect(await cost()).toBe(0);
    await seedCase(null, { ...base, repairCost: "200.00" });
    await seedCase("AWAITING_TECHNICAL", { ...base, repairCost: "50.00" });
    expect(await count()).toBe(2);
    expect(await cost()).toBe(250);
  });
});

describe("legacy INSURANCE / POLICE_REPORT attachments: Phase 1 changes no access", () => {
  it("a project member with only read access still downloads a legacy POLICE_REPORT and INSURANCE file (enforcement is not wired yet)", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const { user: viewer, client: vc } = await userAndClient(["VIEWER"]);
    const project = await createProject({ members: [viewer.id] });
    const vehicle = await createVehicle(project.id);
    const a = await seedCase(null, { projectId: project.id, vehicleId: vehicle.id, createdBy: user.id });
    for (const category of ["POLICE_REPORT", "INSURANCE"]) {
      expect((await client.upload(`/api/accidents/${a.id}/attachments?category=${category}`, PDF_BYTES, "application/pdf", "post")).status).toBe(201);
    }
    const detail = await vc.get(`/api/accidents/${a.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.attachments).toHaveLength(2);
    for (const att of detail.body.data.attachments) expect((await vc.get(`/api/accident-attachments/${att.id}/file`)).status).toBe(200);
  });
});

describe("accident catalog sync tool", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try {
      const out = execFileSync("npx", ["tsx", "src/scripts/sync-accident-catalog.ts", ...args], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  };
  const hashOf = (out: string) => /PLAN HASH: (\w+)/.exec(out)![1]!;
  const dump = async () => JSON.stringify((await db.execute(sql`select r.key as r, p.key as p, rp.scope as s from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id order by 1, 2`)).rows);
  const dumpOthers = async (exclude: string[]) => JSON.stringify((await db.execute(sql`select r.key as r, p.key as p, rp.scope as s from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where r.key not in (${sql.join(exclude.map((k) => sql`${k}`), sql`, `)}) order by 1, 2`)).rows);
  const counts = async () => JSON.stringify((await db.execute(sql`select (select count(*) from permissions) p, (select count(*) from roles) r, (select count(*) from role_permissions) rp`)).rows[0]);

  /** Production-like state: no accident permissions/roles, PROJECT_MANAGER carrying a pending difference, a custom FINANCE grant. */
  async function productionLikeState() {
    // test users of other files may hold these roles: release them first (a production-like database has none yet)
    await db.execute(sql`delete from user_roles where role_id in (select id from roles where organization_id is null and key in ('ACCIDENT_MANAGER','INSURANCE_OFFICER'))`);
    await db.delete(roles).where(and(isNull(roles.organizationId), sql`${roles.key} in ('ACCIDENT_MANAGER','INSURANCE_OFFICER')`));
    await db.delete(permissions).where(sql`${permissions.key} in (${sql.join(ACCIDENT_PERMISSIONS.map((p) => sql`${p}`), sql`, `)})`);
    const grant = async (role: string, perm: string, scope: Scope | null) => {
      const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.key, role), isNull(roles.organizationId)));
      const [p] = await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.key, perm));
      await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, r!.id), eq(rolePermissions.permissionId, p!.id)));
      if (scope) await db.insert(rolePermissions).values({ roleId: r!.id, permissionId: p!.id, scope });
    };
    await grant("PROJECT_MANAGER", "finance.read", "PROJECT"); // pending removal in code
    await grant("PROJECT_MANAGER", "dashboard.view", "ALL"); // pending scope change in code
    await grant("PROJECT_MANAGER", "vendors.manage", "ALL"); // pending removal in code
    await grant("FINANCE", "users.read", "ALL"); // a grant the code does not declare
  }

  it("planner: only the six permissions, the two roles and (opt-in) TECHNICAL's two grants; never PROJECT_MANAGER", async () => {
    await productionLikeState();
    try {
      const state = await readCatalogState(db);
      const plan = planAccidentCatalog(state);
      expect(plan.permissionsToCreate).toEqual([...ACCIDENT_PERMISSIONS].sort());
      expect(plan.rolesToCreate).toEqual(["ACCIDENT_MANAGER", "INSURANCE_OFFICER"]);
      expect(new Set(plan.grantsToAdd.map((g) => g.role))).toEqual(new Set([...MANAGED_ROLES, "SUPER_ADMIN"]));
      // the administrator gets the accident permissions only, with scope ALL (the general bootstrap is not run)
      expect(plan.grantsToAdd.filter((g) => g.role === "SUPER_ADMIN")).toEqual(ACCIDENT_PERMISSIONS.map((permission) => ({ role: "SUPER_ADMIN", permission, scope: "ALL" })).sort((a, b) => a.permission.localeCompare(b.permission)));
      expect(plan.grantsToAdd.length).toBe(Object.keys(ROLES.ACCIDENT_MANAGER.grants).length + Object.keys(ROLES.INSURANCE_OFFICER.grants).length + ACCIDENT_PERMISSIONS.length);
      const withTech = planAccidentCatalog(state, { includeTechnical: true });
      expect(withTech.grantsToAdd.filter((g) => g.role === "TECHNICAL").map((g) => g.permission).sort()).toEqual(["accidents.documents.sensitive", "accidents.review.technical"]);
      expect(withTech.hash).not.toBe(plan.hash);
      for (const p of [plan, withTech]) {
        assertPlanScope(p);
        expect(p.grantsToAdd.some((g) => g.role === "PROJECT_MANAGER")).toBe(false);
      }
      // a forged plan that names PROJECT_MANAGER (or FINANCE) is refused
      expect(() => assertPlanScope({ ...plan, grantsToAdd: [...plan.grantsToAdd, { role: "PROJECT_MANAGER", permission: "accidents.documents.sensitive", scope: "PROJECT" }] })).toThrow(/never changes/);
      expect(() => assertPlanScope({ ...withTech, grantsToAdd: [{ role: "TECHNICAL", permission: "finance.read", scope: "ALL" }] })).toThrow();
      // the administrator: only accident permissions and only ALL
      expect(() => assertPlanScope({ ...plan, grantsToAdd: [{ role: "SUPER_ADMIN", permission: "finance.read", scope: "ALL" }] })).toThrow(/never changes/);
      expect(() => assertPlanScope({ ...plan, grantsToAdd: [{ role: "SUPER_ADMIN", permission: "accidents.assign", scope: "PROJECT" }] })).toThrow(/never changes/);
      expect(() => assertPlanScope({ ...plan, grantsToAdd: [{ role: "TECHNICAL", permission: "accidents.review.technical", scope: "PROJECT" }] })).toThrow(); // not opted in
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  });

  it("preview and every refused apply write nothing; a wrong hash, a missing confirmation and a Render host are refused", async () => {
    await productionLikeState();
    try {
      const before = { c: await counts(), d: await dump() };
      const preview = cli([]);
      expect(preview.code).toBe(0);
      expect(preview.out).toContain("preview only: nothing was written");
      expect(preview.out).toContain("PROJECT_MANAGER and every other system role: not touched");
      expect(preview.out).not.toContain(process.env.TEST_DATABASE_URL!);
      const hash = hashOf(preview.out);
      for (const [args, env, why] of [
        [["--apply"], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" }, "no hash"],
        [["--apply", "--plan-hash=deadbeef"], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" }, "wrong hash"],
        [["--apply", `--plan-hash=${hash}`], {}, "no confirmation"],
        [["--apply", `--plan-hash=${hash}`], { EF_CONFIRM_ACCIDENT_CATALOG: "no" }, "confirmation not yes"],
        [["--apply", `--plan-hash=${hash}`, "--include-technical"], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" }, "hash of another plan"],
      ] as [string[], Record<string, string>, string][]) {
        const r = cli(args, env);
        expect(r.code, why).toBe(2);
        expect(r.out, why).toContain("Nothing was written");
        expect({ c: await counts(), d: await dump() }, why).toEqual(before);
      }
      const render = cli(["--apply", `--plan-hash=${hash}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes", DATABASE_URL: "postgres://u:p@dpg-abc123.oregon-postgres.render.com:5432/x" });
      expect(render.code).not.toBe(0);
      expect({ c: await counts(), d: await dump() }).toEqual(before);
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  }, 120_000);

  it("an approved apply adds only the accident catalog: every existing role's grants (PROJECT_MANAGER's pending state included) stay byte-identical", async () => {
    await productionLikeState();
    try {
      const othersBefore = await dumpOthers(["ACCIDENT_MANAGER", "INSURANCE_OFFICER", "SUPER_ADMIN"]);
      const permsBefore = (await db.select({ key: permissions.key, d: permissions.descriptionAr }).from(permissions)).map((p) => `${p.key}|${p.d}`).sort();
      const hash = hashOf(cli([]).out);
      const r = cli(["--apply", `--plan-hash=${hash}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("Applied");
      expect(await dumpOthers(["ACCIDENT_MANAGER", "INSURANCE_OFFICER", "SUPER_ADMIN"])).toBe(othersBefore); // PM, FINANCE (custom grant), TECHNICAL … unchanged
      // SUPER_ADMIN gained exactly the accident permissions, nothing else
      const saGrants = (await readCatalogState(db)).roles.find((x) => x.key === "SUPER_ADMIN")!.grants;
      for (const permission of ACCIDENT_PERMISSIONS) expect(saGrants[permission], permission).toBe("ALL");
      const permsAfter = (await db.select({ key: permissions.key, d: permissions.descriptionAr }).from(permissions)).map((p) => `${p.key}|${p.d}`).sort();
      expect(permsAfter.filter((p) => !permsBefore.includes(p)).map((p) => p.split("|")[0]).sort()).toEqual([...ACCIDENT_PERMISSIONS].sort());
      expect(permsBefore.every((p) => permsAfter.includes(p))).toBe(true);
      const state = await readCatalogState(db);
      for (const role of MANAGED_ROLES) expect(state.roles.find((x) => x.key === role)!.grants).toEqual(ROLES[role].grants);
      // PM still carries its pending (non-code) grants; the TECHNICAL role did not get the accident grants (not opted in)
      const pm = state.roles.find((x) => x.key === "PROJECT_MANAGER")!.grants;
      expect(pm["finance.read"]).toBe("PROJECT");
      expect(pm["vendors.manage"]).toBe("ALL");
      expect(pm["accidents.documents.sensitive"]).toBeUndefined();
      expect(state.roles.find((x) => x.key === "TECHNICAL")!.grants["accidents.review.technical"]).toBeUndefined();
      // idempotent: a second preview has nothing to add and a second apply changes nothing
      const again = cli([]);
      expect(again.out).toContain("permissions to create (0)");
      const snapshot = await dump();
      expect(cli(["--apply", `--plan-hash=${hashOf(again.out)}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" }).out).toContain("Nothing to do");
      expect(await dump()).toBe(snapshot);
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  }, 120_000);

  it("with --include-technical exactly TECHNICAL's two grants are added on top; PROJECT_MANAGER still untouched", async () => {
    await productionLikeState();
    try {
      const everyoneButTechnical = Object.keys(ROLES).filter((k) => k !== "TECHNICAL");
      const pmBefore = await dumpOthers(everyoneButTechnical.filter((k) => k !== "PROJECT_MANAGER").concat("TECHNICAL"));
      const othersBefore = await dumpOthers(["TECHNICAL", "SUPER_ADMIN", ...MANAGED_ROLES]);
      const hash = hashOf(cli(["--include-technical"]).out);
      const r = cli(["--apply", "--include-technical", `--plan-hash=${hash}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" });
      expect(r.code, r.out).toBe(0);
      expect(await dumpOthers(everyoneButTechnical.filter((k) => k !== "PROJECT_MANAGER").concat("TECHNICAL"))).toBe(pmBefore);
      expect(await dumpOthers(["TECHNICAL", "SUPER_ADMIN", ...MANAGED_ROLES])).toBe(othersBefore);
      const tech = (await readCatalogState(db)).roles.find((x) => x.key === "TECHNICAL")!.grants;
      expect(tech["accidents.review.technical"]).toBe("PROJECT");
      expect(tech["accidents.documents.sensitive"]).toBe("PROJECT");
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  }, 120_000);

  it("a write that would exceed the plan is rolled back by the in-transaction verification", async () => {
    await productionLikeState();
    try {
      const plan = planAccidentCatalog(await readCatalogState(db));
      const before = await dump();
      // sabotage: a deferred extra insert inside the same transaction that the proof must catch
      await expect(
        db.transaction(async (tx) => {
          await applyAccidentCatalogPlan(tx, plan);
          throw new Error("simulated failure after apply");
        }),
      ).rejects.toThrow(/simulated/);
      expect(await dump()).toBe(before); // the whole transaction rolled back
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  });
});
