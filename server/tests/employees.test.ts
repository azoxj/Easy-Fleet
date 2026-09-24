import { and, eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, employees } from "../src/db/schema/index.js";
import { app, createDriverFor, createEmployee, createProject, createUser, createVehicle, login, uid, userAndClient } from "./helpers.js";

const NATIONAL_ID = () => `1${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

async function pmSetup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const pB = await createProject();
  return { pm, pA, pB, pmc: await login(pm.email) };
}

describe("employees — CRUD & validation", () => {
  it("SUPER_ADMIN creates, reads, updates and archives an employee (audited)", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    const nid = NATIONAL_ID();
    const res = await client.post("/api/employees", {
      employeeNumber: `EMP-${uid()}`,
      fullName: "موظف تجريبي",
      nationalIdOrIqama: nid,
      phone: "+966500000000",
      email: "Emp@Example.test",
      jobTitle: "مشرف",
      projectId: p.id,
      hireDate: "2026-01-10",
    });
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty("nationalIdOrIqama");
    const id = res.body.data.id;

    const detail = await client.get(`/api/employees/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.nationalIdOrIqama).toBe(nid); // editor sees full value
    expect(detail.body.data.email).toBe("emp@example.test");
    expect(detail.body.data.projectName).toBe(p.name);

    expect((await client.patch(`/api/employees/${id}`, { jobTitle: "مدير موقع", status: "SUSPENDED" })).status).toBe(200);
    expect((await client.post(`/api/employees/${id}/archive`)).status).toBe(200);
    expect((await client.patch(`/api/employees/${id}`, { jobTitle: "x y" })).status).toBe(400); // archived is read-only
    expect((await client.post(`/api/employees/${id}/archive`)).status).toBe(400);

    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "employee"), eq(auditLogs.entityId, id)));
    expect(logs.map((l) => l.action).sort()).toEqual(["EMPLOYEE_ARCHIVED", "EMPLOYEE_CREATED", "EMPLOYEE_UPDATED"]);
    expect(JSON.stringify(logs)).not.toContain(nid); // national id never lands in the audit trail
  });

  it("rejects invalid input with 400 and duplicates with 409", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const num = `DUP-${uid()}`;
    expect((await client.post("/api/employees", { employeeNumber: num, fullName: "أ" })).status).toBe(400);
    expect((await client.post("/api/employees", { employeeNumber: "bad number!", fullName: "اسم صحيح" })).status).toBe(400);
    expect((await client.post("/api/employees", { employeeNumber: `N-${uid()}`, fullName: "اسم صحيح", nationalIdOrIqama: "12ab" })).status).toBe(400);
    expect((await client.post("/api/employees", { employeeNumber: `N-${uid()}`, fullName: "اسم صحيح", email: "not-an-email" })).status).toBe(400);
    expect((await client.post("/api/employees", { employeeNumber: `N-${uid()}`, fullName: "اسم صحيح", status: "ARCHIVED" })).status).toBe(400);
    expect((await client.post("/api/employees", { employeeNumber: num, fullName: "اسم صحيح" })).status).toBe(201);
    expect((await client.post("/api/employees", { employeeNumber: num, fullName: "اسم آخر" })).status).toBe(409);
    const nid = NATIONAL_ID();
    expect((await client.post("/api/employees", { employeeNumber: `N-${uid()}`, fullName: "اسم صحيح", nationalIdOrIqama: nid })).status).toBe(201);
    expect((await client.post("/api/employees", { employeeNumber: `N-${uid()}`, fullName: "اسم صحيح", nationalIdOrIqama: nid })).status).toBe(409);
  });

  it("401 without session, 400 invalid id, 404 unknown id", async () => {
    expect((await request(app).get("/api/employees")).status).toBe(401);
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    expect((await client.get("/api/employees/not-a-uuid")).status).toBe(400);
    expect((await client.get("/api/employees/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await client.patch("/api/employees/00000000-0000-4000-8000-000000000000", { jobTitle: "x y" })).status).toBe(404);
  });

  it("roles without employee permissions get 403", async () => {
    for (const role of ["FINANCE", "TECHNICAL", "USER", "VIEWER"] as const) {
      const { client } = await userAndClient([role]);
      expect((await client.get("/api/employees")).status, role).toBe(403);
      expect((await client.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح" })).status, role).toBe(403);
    }
  });
});

describe("employees — project scope & IDOR", () => {
  it("PM of project A does not see, update or archive employees of project B", async () => {
    const { pmc, pA, pB } = await pmSetup();
    const mine = await createEmployee(pA.id);
    const theirs = await createEmployee(pB.id);
    const unassigned = await createEmployee(null);
    const list = await pmc.get("/api/employees?pageSize=100");
    const ids = list.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(unassigned.id);
    expect((await pmc.get(`/api/employees/${theirs.id}`)).status).toBe(404);
    expect((await pmc.patch(`/api/employees/${theirs.id}`, { jobTitle: "اختراق" })).status).toBe(404);
    expect((await pmc.post(`/api/employees/${theirs.id}/archive`)).status).toBe(403); // no archive permission at all
    // filtering by the foreign project returns nothing
    expect((await pmc.get(`/api/employees?projectId=${pB.id}`)).body.data).toHaveLength(0);
    const [row] = await db.select().from(employees).where(eq(employees.id, theirs.id));
    expect(row!.jobTitle).toBeNull();
  });

  it("projectId in the request cannot move an employee outside the caller's scope", async () => {
    const { pmc, pA, pB } = await pmSetup();
    const e = await createEmployee(pA.id);
    expect((await pmc.patch(`/api/employees/${e.id}`, { projectId: pB.id })).status).toBe(403);
    expect((await pmc.patch(`/api/employees/${e.id}`, { projectId: null })).status).toBe(403);
    expect((await pmc.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح", projectId: pB.id })).status).toBe(403);
    expect((await pmc.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح" })).status).toBe(403);
    const ok = await pmc.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح", projectId: pA.id });
    expect(ok.status).toBe(201);
    const [row] = await db.select().from(employees).where(eq(employees.id, e.id));
    expect(row!.projectId).toBe(pA.id);
  });

  it("unknown fields such as organizationId are rejected", async () => {
    const { pmc, pA } = await pmSetup();
    const e = await createEmployee(pA.id);
    expect((await pmc.patch(`/api/employees/${e.id}`, { organizationId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
  });

  it("national ID is never in list/search responses and is masked for non-editors", async () => {
    const { pmc, pA } = await pmSetup();
    const nid = NATIONAL_ID();
    const e = await createEmployee(pA.id, { nationalId: nid, fullName: `موظف بهوية ${uid()}` });
    const list = await pmc.get("/api/employees?pageSize=100");
    expect(JSON.stringify(list.body)).not.toContain(nid);
    // searching by national id does not reveal the employee
    expect((await pmc.get(`/api/employees?q=${nid}`)).body.data).toHaveLength(0);
    // PM can edit → sees full value
    expect((await pmc.get(`/api/employees/${e.id}`)).body.data.nationalIdOrIqama).toBe(nid);

    // A driver reading their own record (ASSIGNED, no update permission) sees it masked.
    const driverUser = await createUser(["DRIVER"]);
    const own = await createEmployee(pA.id, { nationalId: NATIONAL_ID(), userId: driverUser.id });
    const dc = await login(driverUser.email);
    const mine = await dc.get(`/api/employees/${own.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.nationalIdOrIqama).toMatch(/^••••\d{4}$/);
    expect(mine.body.data.nationalIdMasked).toBe(true);
    expect((await dc.get(`/api/employees/${e.id}`)).status).toBe(404);
    expect((await dc.get("/api/employees")).body.data.map((x: { id: string }) => x.id)).toEqual([own.id]);
  });

  it("only admins can link an employee to a login account", async () => {
    const { pmc, pA } = await pmSetup();
    const u = await createUser(["USER"]);
    expect((await pmc.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح", projectId: pA.id, userId: u.id })).status).toBe(403);
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const r = await client.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح", userId: u.id });
    expect(r.status).toBe(201);
    expect((await client.post("/api/employees", { employeeNumber: `X-${uid()}`, fullName: "اسم صحيح", userId: u.id })).status).toBe(409);
  });

  it("archiving or moving an employee who currently drives a vehicle is blocked", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    const p2 = await createProject();
    const e = await createEmployee(p.id);
    const d = await createDriverFor(e.id);
    await createVehicle(p.id, { assignedDriverId: d.id });
    expect((await client.post(`/api/employees/${e.id}/archive`)).status).toBe(409);
    expect((await client.patch(`/api/employees/${e.id}`, { projectId: p2.id })).status).toBe(409);
  });
});
