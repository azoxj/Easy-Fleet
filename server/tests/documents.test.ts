import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, permissions, projectUsers, rolePermissions, roles, userRoles, vehicleDocuments } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { app, createDriverFor, createEmployee, createProject, createUser, createVehicle, login, PDF_BYTES, PNG_BYTES, uid, userAndClient } from "./helpers.js";

// Pin "today" so every status assertion is deterministic.
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

async function setup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const pB = await createProject();
  const vA = await createVehicle(pA.id);
  const vB = await createVehicle(pB.id);
  return { pm, pA, pB, vA, vB, pmc: await login(pm.email) };
}

describe("registration", () => {
  it("adds, computes status server-side, renews (supersedes) and keeps history", async () => {
    const { pmc, vA } = await setup();
    const r1 = await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-1", issueDate: "2025-07-01", expiryDate: "2026-07-01" });
    expect(r1.status).toBe(201);
    expect(r1.body.data.status).toBe("EXPIRING_SOON");
    expect(r1.body.data.daysLeft).toBe(16);

    const r2 = await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-2", issueDate: "2026-06-10", expiryDate: "2027-06-10" });
    expect(r2.status).toBe(201);
    expect(r2.body.data.status).toBe("ACTIVE");

    const got = await pmc.get(`/api/vehicles/${vA.id}/registration`);
    expect(got.body.data.current.documentNumber).toBe("REG-2");
    expect(got.body.data.history.map((h: { documentNumber: string }) => h.documentNumber)).toEqual(["REG-1"]);
    // superseded copies are read-only
    expect((await pmc.patch(`/api/vehicle-documents/${r1.body.data.id}`, { notes: "x" })).status).toBe(400);
    expect((await pmc.patch(`/api/vehicle-documents/${r2.body.data.id}`, { notes: "محدثة" })).status).toBe(200);
  });

  it("the database refuses two current registrations for one vehicle", async () => {
    const { pmc, vA } = await setup();
    const orgId = vA.organizationId;
    await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-A", expiryDate: "2027-01-01" });
    await expect(
      db.insert(vehicleDocuments).values({ organizationId: orgId, vehicleId: vA.id, documentType: "REGISTRATION", documentNumber: "REG-B", expiryDate: "2027-02-01" }),
    ).rejects.toThrow();
  });

  it("validates input and never accepts a client-supplied status", async () => {
    const { pmc, vA } = await setup();
    expect((await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "R", expiryDate: "2027-01-01" })).status).toBe(400);
    expect((await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-X" })).status).toBe(400);
    expect((await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-X", expiryDate: "01/01/2027" })).status).toBe(400);
    expect((await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-X", issueDate: "2027-05-01", expiryDate: "2027-01-01" })).status).toBe(400);
    expect((await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-X", expiryDate: "2020-01-01", status: "ACTIVE" })).status).toBe(400);
    const r = await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-X", expiryDate: "2020-01-01" });
    expect(r.body.data.status).toBe("EXPIRED");
    expect((await pmc.patch(`/api/vehicle-documents/${r.body.data.id}`, { status: "ACTIVE" })).status).toBe(400);
  });

  it("cross-project: PM of A cannot read or write registrations of B", async () => {
    const { pmc, vB } = await setup();
    expect((await pmc.get(`/api/vehicles/${vB.id}/registration`)).status).toBe(404);
    expect((await pmc.post(`/api/vehicles/${vB.id}/registration`, { documentNumber: "REG-Z", expiryDate: "2027-01-01" })).status).toBe(404);
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const r = await admin.post(`/api/vehicles/${vB.id}/registration`, { documentNumber: "REG-B1", expiryDate: "2027-01-01" });
    expect((await pmc.patch(`/api/vehicle-documents/${r.body.data.id}`, { notes: "x" })).status).toBe(404);
  });
});

describe("insurance", () => {
  it("adds and renews a policy with computed status", async () => {
    const { pmc, vA } = await setup();
    const p1 = await pmc.post(`/api/vehicles/${vA.id}/insurance`, { provider: "شركة تأمين تجريبية", policyNumber: `POL-${uid()}`, expiryDate: "2026-06-01", coverageType: "THIRD_PARTY", premiumAmount: "1500.00" });
    expect(p1.status).toBe(201);
    expect(p1.body.data.status).toBe("EXPIRED");
    const p2 = await pmc.post(`/api/vehicles/${vA.id}/insurance`, { provider: "شركة تأمين تجريبية", policyNumber: `POL-${uid()}`, issueDate: "2026-06-01", expiryDate: "2027-06-01", coverageType: "COMPREHENSIVE" });
    expect(p2.body.data.status).toBe("ACTIVE");
    const got = await pmc.get(`/api/vehicles/${vA.id}/insurance`);
    expect(got.body.data.current.id).toBe(p2.body.data.id);
    expect(got.body.data.history).toHaveLength(1);
    expect((await pmc.patch(`/api/insurance/${p2.body.data.id}`, { premiumAmount: "2100.50" })).body.data.premiumAmount).toBe("2100.50");
    expect((await pmc.patch(`/api/insurance/${p1.body.data.id}`, { notes: "x" })).status).toBe(400); // superseded
  });

  it("validates coverage type, money and duplicates", async () => {
    const { pmc, vA } = await setup();
    const base = { provider: "مزود", expiryDate: "2027-01-01", coverageType: "COMPREHENSIVE" };
    expect((await pmc.post(`/api/vehicles/${vA.id}/insurance`, { ...base, policyNumber: "P-1", coverageType: "EVERYTHING" })).status).toBe(400);
    expect((await pmc.post(`/api/vehicles/${vA.id}/insurance`, { ...base, policyNumber: "P-1", premiumAmount: "-3" })).status).toBe(400);
    const num = `P-${uid()}`;
    expect((await pmc.post(`/api/vehicles/${vA.id}/insurance`, { ...base, policyNumber: num })).status).toBe(201);
    const v2 = await createVehicle(vA.projectId);
    expect((await pmc.post(`/api/vehicles/${v2.id}/insurance`, { ...base, policyNumber: num })).status).toBe(409);
  });

  it("security #3: user of project A cannot see insurance of a project B vehicle", async () => {
    const { pmc, vB } = await setup();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const p = await admin.post(`/api/vehicles/${vB.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2027-01-01", coverageType: "OTHER" });
    expect((await pmc.get(`/api/vehicles/${vB.id}/insurance`)).status).toBe(404);
    expect((await pmc.patch(`/api/insurance/${p.body.data.id}`, { notes: "x" })).status).toBe(404);
    expect((await pmc.get(`/api/insurance/${p.body.data.id}/file`)).status).toBe(404);
    // USER role has no insurance permission at all
    const u = await createUser(["USER"]);
    const proj = await createProject({ members: [u.id] });
    const v = await createVehicle(proj.id);
    const uc = await login(u.email);
    expect((await uc.get(`/api/vehicles/${v.id}/insurance`)).status).toBe(403);
  });

  it("FINANCE reads all insurance but cannot create; DRIVER reads only assigned vehicles", async () => {
    const { vA, vB } = await setup();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    await admin.post(`/api/vehicles/${vA.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2027-01-01", coverageType: "OTHER" });
    const { client: fin } = await userAndClient(["FINANCE"]);
    expect((await fin.get(`/api/vehicles/${vA.id}/insurance`)).status).toBe(200);
    expect((await fin.post(`/api/vehicles/${vA.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2027-01-01", coverageType: "OTHER" })).status).toBe(403);

    const du = await createUser(["DRIVER"]);
    const d = await createDriverFor((await createEmployee(vA.projectId, { userId: du.id })).id);
    expect((await admin.put(`/api/vehicles/${vA.id}/driver`, { driverId: d.id })).status).toBe(200);
    const dc = await login(du.email);
    expect((await dc.get(`/api/vehicles/${vA.id}/insurance`)).status).toBe(200);
    expect((await dc.get(`/api/vehicles/${vB.id}/insurance`)).status).toBe(404);
    expect((await dc.post(`/api/vehicles/${vA.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2027-01-01", coverageType: "OTHER" })).status).toBe(403);
  });
});

describe("generic vehicle documents", () => {
  it("CRUD with restricted types, soft delete and audit", async () => {
    const { pmc, vA } = await setup();
    expect((await pmc.post(`/api/vehicles/${vA.id}/documents`, { documentType: "REGISTRATION" })).status).toBe(400);
    expect((await pmc.post(`/api/vehicles/${vA.id}/documents`, { documentType: "INSURANCE" })).status).toBe(400);
    const d = await pmc.post(`/api/vehicles/${vA.id}/documents`, { documentType: "WARRANTY", documentNumber: "W-1", issuer: "الوكيل", expiryDate: "2026-07-10" });
    expect(d.status).toBe(201);
    expect(d.body.data.status).toBe("EXPIRING_SOON");
    const list = await pmc.get(`/api/vehicles/${vA.id}/documents`);
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(d.body.data.id);
    // PM has no delete permission
    expect((await pmc.delete(`/api/vehicle-documents/${d.body.data.id}`)).status).toBe(403);
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    expect((await admin.delete(`/api/vehicle-documents/${d.body.data.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/vehicle-documents/${d.body.data.id}`)).status).toBe(404);
    expect((await pmc.get(`/api/vehicles/${vA.id}/documents`)).body.data.map((x: { id: string }) => x.id)).not.toContain(d.body.data.id);
    const [row] = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.id, d.body.data.id));
    expect(row!.deletedAt).not.toBeNull(); // kept for the audit trail
  });

  it("security #5: a document outside the caller's scope cannot be deleted (PROJECT-scoped delete role)", async () => {
    const { pA, vA, vB } = await setup();
    // A tenant custom role granting vehicle_documents.delete with PROJECT scope only.
    const [perm] = await db.select().from(permissions).where(eq(permissions.key, "vehicle_documents.delete"));
    const [readPerm] = await db.select().from(permissions).where(eq(permissions.key, "vehicle_documents.read"));
    const [role] = await db.insert(roles).values({ organizationId: vA.organizationId, key: `DOC_CLERK_${uid()}`, nameAr: "كاتب مستندات" }).returning();
    await db.insert(rolePermissions).values([
      { roleId: role!.id, permissionId: perm!.id, scope: "PROJECT" },
      { roleId: role!.id, permissionId: readPerm!.id, scope: "PROJECT" },
    ]);
    const clerk = await createUser(["VIEWER"]);
    await db.insert(userRoles).values({ userId: clerk.id, roleId: role!.id });
    await db.insert(projectUsers).values({ projectId: pA.id, userId: clerk.id });

    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const inA = await admin.post(`/api/vehicles/${vA.id}/documents`, { documentType: "OTHER", documentNumber: "O-A" });
    const inB = await admin.post(`/api/vehicles/${vB.id}/documents`, { documentType: "OTHER", documentNumber: "O-B" });
    const cc = await login(clerk.email);
    expect((await cc.delete(`/api/vehicle-documents/${inB.body.data.id}`)).status).toBe(404);
    const [stillThere] = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.id, inB.body.data.id));
    expect(stillThere!.deletedAt).toBeNull();
    expect((await cc.delete(`/api/vehicle-documents/${inA.body.data.id}`)).status).toBe(204);
    // roles without delete permission get 403
    const { client: viewer } = await userAndClient(["VIEWER"]);
    expect((await viewer.delete(`/api/vehicle-documents/${inB.body.data.id}`)).status).toBe(403);
  });

  it("IDOR on document ids: unknown, invalid and foreign ids", async () => {
    const { pmc, vB } = await setup();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const d = await admin.post(`/api/vehicles/${vB.id}/documents`, { documentType: "OWNERSHIP", documentNumber: "OWN-1" });
    expect((await pmc.patch(`/api/vehicle-documents/${d.body.data.id}`, { notes: "x" })).status).toBe(404);
    expect((await pmc.get(`/api/vehicle-documents/${d.body.data.id}/file`)).status).toBe(404);
    expect((await pmc.get(`/api/vehicles/${vB.id}/documents`)).status).toBe(404);
    expect((await pmc.patch("/api/vehicle-documents/not-a-uuid", { notes: "x" })).status).toBe(400);
    expect((await pmc.patch("/api/vehicle-documents/00000000-0000-4000-8000-000000000000", { notes: "x" })).status).toBe(404);
  });
});

describe("document files", () => {
  it("uploads a validated file and downloads it only with authorization", async () => {
    const { pmc, vA, vB } = await setup();
    const r = await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-F", expiryDate: "2027-01-01" });
    const id = r.body.data.id;
    const up = await pmc.agent.put(`/api/vehicle-documents/${id}/file`).set("X-CSRF-Token", pmc.csrf).set("Content-Type", "application/pdf").set("X-File-Name", encodeURIComponent("استمارة.pdf")).send(PDF_BYTES);
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ fileName: "استمارة.pdf", fileMime: "application/pdf" });
    expect(JSON.stringify(up.body)).not.toMatch(/storage|\/tmp|[0-9a-f]{8}-[0-9a-f]{4}-.*\/[0-9a-f]{8}-/); // no storage path leaked

    const dl = await pmc.get(`/api/vehicle-documents/${id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(dl.body as Buffer, PDF_BYTES)).toBe(0);

    // security #7: no session → 401; other project → 404; no permission → 403
    expect((await request(app).get(`/api/vehicle-documents/${id}/file`)).status).toBe(401);
    const other = await createUser(["PROJECT_MANAGER"]);
    await createProject({ managerId: other.id });
    expect((await (await login(other.email)).get(`/api/vehicle-documents/${id}/file`)).status).toBe(404);
    const noPerm = await createUser(["USER"]);
    // USER holds registration.read in PROJECT scope but is not in project A
    expect((await (await login(noPerm.email)).get(`/api/vehicle-documents/${id}/file`)).status).toBe(404);

    const downloads = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "FILE_DOWNLOADED"), eq(auditLogs.entityId, id)));
    expect(downloads).toHaveLength(1);
    void vB;
  });

  it("rejects disguised, empty, oversized and mismatched uploads", async () => {
    const { pmc, vA } = await setup();
    const p = await pmc.post(`/api/vehicles/${vA.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2027-01-01", coverageType: "OTHER" });
    const put = (type: string, body: Buffer) => pmc.agent.put(`/api/insurance/${p.body.data.id}/file`).set("X-CSRF-Token", pmc.csrf).set("Content-Type", type).send(body);
    expect((await put("application/pdf", Buffer.from("MZ\x90\x00 this is an exe"))).status).toBe(400);
    expect((await put("application/pdf", Buffer.alloc(0))).status).toBe(400);
    expect((await put("image/jpeg", PNG_BYTES)).status).toBe(400); // content-type does not match content
    expect((await put("application/pdf", Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024 + 10)]))).status).toBe(413);
    expect((await put("image/png", PNG_BYTES)).status).toBe(201);
    // CSRF still required for uploads
    expect((await pmc.agent.put(`/api/insurance/${p.body.data.id}/file`).set("Content-Type", "image/png").send(PNG_BYTES)).status).toBe(403);
  });

  it("a user without update rights cannot upload", async () => {
    const { vA } = await setup();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const r = await admin.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-U", expiryDate: "2027-01-01" });
    const { client: fin } = await userAndClient(["FINANCE"]);
    const res = await fin.agent.put(`/api/vehicle-documents/${r.body.data.id}/file`).set("X-CSRF-Token", fin.csrf).set("Content-Type", "application/pdf").send(PDF_BYTES);
    expect(res.status).toBe(403);
  });
});

describe("compliance overview & timeline", () => {
  it("summarises registration, insurance, driver license and alerts", async () => {
    const { pmc, vA, pA } = await setup();
    let c = await pmc.get(`/api/vehicles/${vA.id}/compliance`);
    expect(c.body.data.alerts.map((a: { kind: string }) => a.kind).sort()).toEqual(["insurance", "registration"]);
    await pmc.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "REG-C", expiryDate: "2026-06-20" });
    await pmc.post(`/api/vehicles/${vA.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2026-01-01", coverageType: "OTHER" });
    const d = await createDriverFor((await createEmployee(pA.id)).id, { licenseExpiryDate: "2026-07-01" });
    expect((await pmc.put(`/api/vehicles/${vA.id}/driver`, { driverId: d.id })).status).toBe(200);
    c = await pmc.get(`/api/vehicles/${vA.id}/compliance`);
    expect(c.body.data.registration.status).toBe("EXPIRING_SOON");
    expect(c.body.data.insurance.status).toBe("EXPIRED");
    expect(c.body.data.driverLicense.licenseStatus).toBe("EXPIRING_SOON");
    expect(c.body.data.alerts.find((a: { kind: string }) => a.kind === "insurance").level).toBe("danger");
    expect(c.body.data.alerts).toHaveLength(3);
  });

  it("parts are hidden when the caller lacks the matching permission", async () => {
    const u = await createUser(["USER"]); // registration.read yes, insurance.read no
    const p = await createProject({ members: [u.id] });
    const v = await createVehicle(p.id);
    const c = await (await login(u.email)).get(`/api/vehicles/${v.id}/compliance`);
    expect(c.status).toBe(200);
    expect(c.body.data.insurance).toBeNull();
    expect(c.body.data.alerts.map((a: { kind: string }) => a.kind)).toEqual(["registration"]);
  });

  it("timeline lists real events with actor, entity, timestamp and description", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const p1 = await createProject();
    const p2 = await createProject();
    const v = (await client.post("/api/vehicles", { plateNumber: `TL-${uid()}`, make: "تجريبي", model: "X", projectId: p1.id })).body.data;
    await client.patch(`/api/vehicles/${v.id}`, { projectId: p2.id });
    await client.patch(`/api/vehicles/${v.id}`, { status: "OUT_OF_SERVICE" });
    await client.post(`/api/vehicles/${v.id}/registration`, { documentNumber: "REG-T", expiryDate: "2027-01-01" });
    await client.post(`/api/vehicles/${v.id}/insurance`, { provider: "مزود", policyNumber: `P-${uid()}`, expiryDate: "2027-01-01", coverageType: "OTHER" });
    await client.post(`/api/vehicles/${v.id}/documents`, { documentType: "WARRANTY", documentNumber: "W-T" });
    const tl = (await client.get(`/api/vehicles/${v.id}/timeline`)).body.data;
    expect(tl.map((e: { action: string }) => e.action)).toEqual([
      "VEHICLE_DOCUMENT_ADDED",
      "INSURANCE_ADDED",
      "REGISTRATION_ADDED",
      "VEHICLE_UPDATED",
      "VEHICLE_UPDATED",
      "VEHICLE_CREATED",
    ]);
    for (const e of tl) {
      expect(e.actor).toBeTruthy();
      expect(e.entity).toBeTruthy();
      expect(e.timestamp).toBeTruthy();
      expect(e.description).toBeTruthy();
    }
    expect(tl[3].description).toContain("تغيير الحالة");
    expect(tl[4].description).toContain(p1.name);
    expect(tl[4].description).toContain(p2.name);
    expect(tl[2].description).toContain("REG-T");
    // no endpoint can write to the timeline
    expect((await client.post(`/api/vehicles/${v.id}/timeline`, { action: "FAKE" })).status).toBe(404);
  });
});
