import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, organizations, projects, vehicles } from "../src/db/schema/index.js";
import { buildImportWorkbook } from "../src/modules/vehicles/import-template.js";
import { IMPORT_COLUMNS } from "../src/modules/vehicles/import-spec.js";
import { SAMPLE_VEHICLES } from "../src/scripts/vehicle-import-sample-data.js";
import { createProject, createUser, createVehicle, defaultOrgId, login, uid, userAndClient, type Client } from "./helpers.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type Row = Record<string, string | number>;

const post = (c: Client, kind: "preview" | "commit", body: Buffer | string, name = "v.xlsx") =>
  c.agent.post(`/api/vehicles/import/${kind}`).set("X-CSRF-Token", c.csrf).set("Content-Type", XLSX).set("X-File-Name", encodeURIComponent(name)).send(body as Buffer);
const sheet = (rows: Row[]) => buildImportWorkbook(rows);
const plates = (...p: string[]) => db.select().from(vehicles).where(inArray(vehicles.plateNumber, p));
const plate = () => `T${uid().toUpperCase()}`;

async function world() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const pB = await createProject();
  const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
  return { pm, pA, pB, sa, pmc: await login(pm.email) };
}
const veh = (project: string, extra: Row = {}): Row => ({ plateNumber: plate(), make: "سوزوكي", model: "فان", year: 2025, project, ...extra });

describe("vehicle import — template", () => {
  it("serves a workbook whose headers are the contract columns", async () => {
    const { sa } = await world();
    const r = await sa.get("/api/vehicles/import/template").buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on("data", (x: Buffer) => d.push(x)); res.on("end", () => cb(null, Buffer.concat(d))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as unknown as ExcelJS.Buffer);
    const headers: string[] = [];
    wb.getWorksheet("المركبات")!.getRow(1).eachCell((c) => headers.push(String(c.value)));
    expect(headers).toEqual(IMPORT_COLUMNS.map((c) => c.header));
    expect(IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual(["plateNumber", "make", "model"]);
  });
});

describe("vehicle import — success", () => {
  it("previews without writing, then creates every vehicle through the normal creation path", async () => {
    const { sa, pA, pB } = await world();
    const a = plate(), b = plate(), c = plate();
    const file = await sheet([
      { plateNumber: a, make: "سوزوكى", model: "فان", year: 2025, fuelType: "بنزبن", project: pA.name, currentOdometer: 120, status: "متاحة", notes: "ملاحظة" },
      { plateNumber: b, make: "تويوتا", model: "خاص", year: 2026, fuelType: "ديزل", project: ` ${pB.name} `, purchasePrice: "15000.50", purchaseDate: "2026-01-02" },
      { plateNumber: c, make: "فورد", model: "ونش" },
    ]);
    const pre = await post(sa, "preview", file);
    expect(pre.status).toBe(200);
    expect(pre.body.data).toMatchObject({ total: 3, valid: 3, invalid: 0 });
    expect(pre.body.data.rows[0].notices.join(" ")).toContain("سوزوكى → سوزوكي");
    expect(pre.body.data.rows[0].notices.join(" ")).toContain("بنزبن → بنزين");
    expect(await plates(a, b, c)).toHaveLength(0); // preview writes nothing

    const res = await post(sa, "commit", file);
    expect(res.status).toBe(201);
    expect(res.body.data.count).toBe(3);
    expect(res.body.data.vehicles.map((v: { plateNumber: string }) => v.plateNumber)).toEqual([a, b, c]);
    const rows = await plates(a, b, c);
    const byPlate = Object.fromEntries(rows.map((r) => [r.plateNumber, r]));
    expect(byPlate[a]).toMatchObject({ make: "سوزوكي", projectId: pA.id, currentOdometer: 120, status: "AVAILABLE", notes: "نوع الوقود: بنزين\nملاحظة" });
    expect(byPlate[b]).toMatchObject({ projectId: pB.id, purchasePrice: "15000.50", purchaseDate: "2026-01-02", notes: "نوع الوقود: ديزل" });
    expect(byPlate[c]).toMatchObject({ projectId: null, year: null, notes: null, currentOdometer: 0 }); // nothing invented
    const logs = await db.select().from(auditLogs).where(inArray(auditLogs.entityId, rows.map((r) => r.id)));
    expect(logs.filter((l) => l.action === "VEHICLE_CREATED")).toHaveLength(3);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "VEHICLES_IMPORTED"))).length).toBeGreaterThan(0);
  });

  it("imports the prepared 25-vehicle file (projects created by name first)", async () => {
    const { sa } = await world();
    const file = readFileSync(path.resolve("../docs/vehicle-import/vehicle-import-25-vehicles.xlsx"));
    const names = [...new Set(SAMPLE_VEHICLES.map((v) => String(v.project)))];
    const orgId = await defaultOrgId();
    const suffix = ` ${uid()}`;
    // unique project names are needed on a shared test database: rename the sheet's projects through a rebuilt copy
    for (const n of names) await db.insert(projects).values({ organizationId: orgId, name: n + suffix, code: `S-${uid().toUpperCase()}`, status: "ACTIVE" });
    const copy = await sheet(SAMPLE_VEHICLES.map((v, i) => ({ ...v, plateNumber: `S${uid().toUpperCase()}${i}`, project: String(v.project) + suffix })));
    expect(file.length).toBeGreaterThan(1000); // the committed sample exists and is a real workbook
    const pre = await post(sa, "preview", file);
    expect(pre.status).toBe(200);
    expect(pre.body.data.total).toBe(25); // 25 rows parsed; plates are unique inside the file
    expect(pre.body.data.rows[0]).toMatchObject({ row: 2, plateNumber: "7440", make: "سوزوكي", model: "فان", year: "2025" }); // data starts right under the header
    expect(pre.body.data.rows[24]).toMatchObject({ row: 26, plateNumber: "3168" });
    const res = await post(sa, "commit", copy);
    expect(res.status).toBe(201);
    expect(res.body.data.count).toBe(25);
  });
});

describe("vehicle import — validation (all or nothing)", () => {
  it("rejects a missing required field and creates nothing, even for the valid rows", async () => {
    const { sa, pA } = await world();
    const good = plate(), bad = plate();
    const file = await sheet([veh(pA.name, { plateNumber: good }), veh(pA.name, { plateNumber: bad, make: "" })]);
    const pre = await post(sa, "preview", file);
    expect(pre.body.data).toMatchObject({ total: 2, valid: 1, invalid: 1 });
    const badRow = pre.body.data.rows.find((r: { plateNumber: string }) => r.plateNumber === bad);
    expect(badRow.row).toBe(3);
    expect(badRow.errors.join(" ")).toContain("الشركة المصنعة");
    const res = await post(sa, "commit", file);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IMPORT_VALIDATION_FAILED");
    expect(res.body.error.details.invalid).toBe(1);
    expect(await plates(good, bad)).toHaveLength(0);
  });

  it("applies the normal vehicle rules (year range, VIN, warranty order, status)", async () => {
    const { sa, pA } = await world();
    const file = await sheet([
      veh(pA.name, { year: 1950 }),
      veh(pA.name, { vin: "SHORT" }),
      veh(pA.name, { warrantyStart: "2026-05-01", warrantyEnd: "2026-01-01" }),
      veh(pA.name, { status: "في الصيانة" }),
      veh(pA.name, { fuelType: "ماء" }),
    ]);
    const pre = await post(sa, "preview", file);
    expect(pre.body.data.invalid).toBe(5);
    for (const r of pre.body.data.rows) expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown project", async () => {
    const { sa } = await world();
    const p = plate();
    const file = await sheet([veh(`مشروع غير موجود ${uid()}`, { plateNumber: p })]);
    const pre = await post(sa, "preview", file);
    expect(pre.body.data.rows[0].errors.join(" ")).toContain("المشروع");
    expect((await post(sa, "commit", file)).status).toBe(422);
    expect(await plates(p)).toHaveLength(0);
  });

  it("reports duplicates: inside the file and against existing vehicles (archived included)", async () => {
    const { sa, pA } = await world();
    const existing = await createVehicle(pA.id, { vehicleNumber: `N-${uid()}` });
    const archived = await createVehicle(pA.id, { status: "ARCHIVED" });
    const dup = plate();
    const file = await sheet([
      veh(pA.name, { plateNumber: dup }),
      veh(pA.name, { plateNumber: dup }),
      veh(pA.name, { plateNumber: existing.plateNumber }),
      veh(pA.name, { plateNumber: archived.plateNumber }),
      veh(pA.name, { vehicleNumber: existing.vehicleNumber! }),
    ]);
    const pre = await post(sa, "preview", file);
    const errs = pre.body.data.rows.map((r: { errors: string[] }) => r.errors.join(" "));
    expect(errs[0]).toBe("");
    expect(errs[1]).toContain("مكرر داخل الملف");
    expect(errs[2]).toContain("بنفس رقم اللوحة");
    expect(errs[3]).toContain("بنفس رقم اللوحة");
    expect(errs[4]).toContain("بنفس الرقم الداخلي");
    expect((await post(sa, "commit", file)).status).toBe(422);
    expect(await plates(dup)).toHaveLength(0);
  });

  it("a partially invalid file creates ZERO vehicles", async () => {
    const { sa, pA } = await world();
    const ps = Array.from({ length: 4 }, plate);
    const file = await sheet([...ps.slice(0, 3).map((p) => veh(pA.name, { plateNumber: p })), veh(pA.name, { plateNumber: ps[3]!, year: "abc" })]);
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(vehicles))[0]!.n;
    expect((await post(sa, "commit", file)).status).toBe(422);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(vehicles))[0]!.n).toBe(before);
    expect(await plates(...ps)).toHaveLength(0);
  });
});

describe("vehicle import — authorization and isolation", () => {
  it("a PROJECT_MANAGER imports into his own project", async () => {
    const { pmc, pA } = await world();
    const p = plate();
    const res = await post(pmc, "commit", await sheet([veh(pA.name, { plateNumber: p })]));
    expect(res.status).toBe(201);
    expect((await plates(p))[0]!.projectId).toBe(pA.id);
  });

  it("a PROJECT_MANAGER is blocked from another project and from a row without a project; nothing is created", async () => {
    const { pmc, pA, pB } = await world();
    const ok = plate(), foreign = plate(), none = plate();
    const file = await sheet([veh(pA.name, { plateNumber: ok }), veh(pB.name, { plateNumber: foreign }), { plateNumber: none, make: "فورد", model: "خاص" }]);
    const pre = await post(pmc, "preview", file);
    const rows = pre.body.data.rows;
    expect(rows[0].valid).toBe(true);
    expect(rows[1].errors.join(" ")).toContain("لا تملك صلاحية");
    expect(rows[2].errors.join(" ")).toContain("مشروع");
    const res = await post(pmc, "commit", file);
    expect(res.status).toBe(422);
    expect(await plates(ok, foreign, none)).toHaveLength(0);
  });

  it("the project comes from the file's name, never from a browser-supplied id", async () => {
    const { pmc, pA, pB } = await world();
    const p = plate();
    const res = await pmc.agent.post(`/api/vehicles/import/commit?projectId=${pB.id}`).set("X-CSRF-Token", pmc.csrf).set("Content-Type", XLSX).set("X-File-Name", "v.xlsx").set("X-Project-Id", pB.id).send(await sheet([veh(pA.name, { plateNumber: p })]));
    expect(res.status).toBe(201);
    expect((await plates(p))[0]!.projectId).toBe(pA.id);
  });

  it("is limited to the caller's organization: another tenant's projects are unknown, its plates are not duplicates", async () => {
    const { sa, pA } = await world();
    const [org2] = await db.insert(organizations).values({ name: `Org ${uid()}`, slug: `org-${uid()}` }).returning();
    const [foreignProject] = await db.insert(projects).values({ organizationId: org2!.id, name: `مشروع آخر ${uid()}`, code: `F-${uid().toUpperCase()}`, status: "ACTIVE" }).returning();
    const shared = plate();
    await db.insert(vehicles).values({ organizationId: org2!.id, plateNumber: shared, make: "x", model: "y" });
    const file = await sheet([veh(foreignProject!.name, { plateNumber: plate() }), veh(pA.name, { plateNumber: shared })]);
    const pre = await post(sa, "preview", file);
    expect(pre.body.data.rows[0].errors.join(" ")).toContain("المشروع");
    expect(pre.body.data.rows[1].valid).toBe(true);
    const ok = await post(sa, "commit", await sheet([veh(pA.name, { plateNumber: shared })]));
    expect(ok.status).toBe(201);
    expect((await db.select().from(vehicles).where(eq(vehicles.plateNumber, shared))).length).toBe(2); // one per organization
  });

  it("needs vehicles.create: other roles and anonymous callers are refused", async () => {
    const file = await sheet([veh("x")]);
    for (const role of ["VIEWER", "DRIVER", "FINANCE", "TECHNICAL"] as const) {
      const { client } = await userAndClient([role]);
      expect((await post(client, "preview", file)).status, role).toBe(403);
      expect((await post(client, "commit", file)).status, role).toBe(403);
      expect((await client.get("/api/vehicles/import/template")).status, role).toBe(403);
    }
  });
});

describe("vehicle import — bad files", () => {
  it("rejects malformed, empty, wrong-type, oversized and header-less files", async () => {
    const { sa, pA } = await world();
    const garbage = Buffer.from("this is not a spreadsheet at all");
    expect((await post(sa, "preview", garbage)).status).toBe(400);
    const fakeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);
    expect((await post(sa, "preview", fakeZip)).status).toBe(400);
    expect((await post(sa, "preview", "")).status).toBe(400); // empty
    expect((await post(sa, "preview", await sheet([veh(pA.name)]), "v.xls")).status).toBe(400); // extension
    expect((await post(sa, "preview", await sheet([veh(pA.name)]), "v.xlsx.exe")).status).toBe(400);
    expect((await post(sa, "preview", Buffer.alloc(2 * 1024 * 1024 + 10, 1))).status).toBe(413);
    const noRows = await post(sa, "commit", await sheet([]));
    expect(noRows.status).toBe(400);
    expect(noRows.body.error.code).toBe("IMPORT_FILE_INVALID");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("المركبات").addRow(["عمود", "آخر"]);
    wb.getWorksheet("المركبات")!.addRow(["a", "b"]);
    const noHeaders = await post(sa, "preview", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(noHeaders.status).toBe(400);
    expect(noHeaders.body.error.message).toContain("رقم اللوحة");
  });

  it("refuses more rows than the limit", async () => {
    const { sa, pA } = await world();
    const many = Array.from({ length: 501 }, () => veh(pA.name));
    const r = await post(sa, "preview", await sheet(many));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("IMPORT_FILE_INVALID");
  });

  it("rejects formulas and cells that start like a formula", async () => {
    const { sa, pA } = await world();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("المركبات");
    ws.addRow(IMPORT_COLUMNS.map((c) => c.header));
    const plateCol = IMPORT_COLUMNS.findIndex((c) => c.key === "plateNumber") + 1;
    const makeCol = IMPORT_COLUMNS.findIndex((c) => c.key === "make") + 1;
    const modelCol = IMPORT_COLUMNS.findIndex((c) => c.key === "model") + 1;
    const r2 = ws.getRow(2);
    r2.getCell(plateCol).value = { formula: "1+1", result: 2 } as ExcelJS.CellFormulaValue;
    r2.getCell(makeCol).value = "فورد";
    r2.getCell(modelCol).value = "خاص";
    const r3 = ws.getRow(3);
    r3.getCell(plateCol).value = plate();
    r3.getCell(makeCol).value = "=HYPERLINK(\"http://evil\")";
    r3.getCell(modelCol).value = "خاص";
    const pre = await post(sa, "preview", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(pre.status).toBe(200);
    expect(pre.body.data.invalid).toBe(2);
    expect(pre.body.data.rows[0].errors.join(" ")).toContain("الصيغ");
    expect(pre.body.data.rows[1].errors.join(" ")).toContain("غير مسموح");
    void pA;
  });
});
