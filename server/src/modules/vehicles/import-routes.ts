import express, { Router } from "express";
import { db } from "../../db/client.js";
import { ctx } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { tr } from "../../i18n/index.js";
import { insertVehicle } from "./create.js";
import { parseWorkbook, validateImport } from "./import.js";
import { buildImportWorkbook } from "./import-template.js";
import { MAX_IMPORT_BYTES } from "./import-spec.js";

/**
 * Bulk vehicle import (.xlsx). Needs vehicles.create; every row then goes through the same validation and project
 * authorization as POST /vehicles. The browser sends only the file: project ids are resolved on the server by name.
 *
 *   GET  /import/template   the template workbook
 *   POST /import/preview    validates the whole file, writes nothing
 *   POST /import/commit     validates again, then creates every vehicle in ONE transaction (all or nothing)
 */
export const vehicleImportRouter = Router();

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const fileBody = express.raw({ type: () => true, limit: MAX_IMPORT_BYTES });

function uploadedFile(req: express.Request): Buffer {
  let name = "";
  try {
    name = decodeURIComponent(String(req.get("x-file-name") ?? ""));
  } catch {
    /* malformed header: treated as a missing name */
  }
  if (!/\.xlsx$/i.test(name)) throw new HttpError(400, "IMPORT_FILE_INVALID", tr("يُقبل ملف Excel بصيغة .xlsx فقط"));
  const buf = req.body as unknown;
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, "IMPORT_FILE_INVALID", tr("الملف فارغ"));
  return buf;
}

vehicleImportRouter.get("/template", requirePermission("vehicles.create"), async (_req, res) => {
  const buf = await buildImportWorkbook();
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader("Content-Disposition", 'attachment; filename="vehicle-import-template.xlsx"');
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buf);
});

vehicleImportRouter.post("/preview", requirePermission("vehicles.create"), uploadRateLimit, fileBody, async (req, res) => {
  const { access } = ctx(req);
  const parsed = await parseWorkbook(uploadedFile(req));
  const { report } = await validateImport(db, access, parsed);
  res.json({ data: report });
});

vehicleImportRouter.post("/commit", requirePermission("vehicles.create"), uploadRateLimit, fileBody, async (req, res) => {
  const { access } = ctx(req);
  const parsed = await parseWorkbook(uploadedFile(req));
  const { report, planned } = await validateImport(db, access, parsed);
  if (report.invalid > 0) {
    throw new HttpError(422, "IMPORT_VALIDATION_FAILED", tr("الملف يحتوي صفوفًا غير صالحة، لم تُضف أي مركبة"), report);
  }
  const created = await db.transaction(async (tx) => {
    const out = [];
    for (const p of planned) out.push({ v: await insertVehicle(tx, req, access, p.body), projectName: p.projectName });
    await audit(tx, req, {
      action: "VEHICLES_IMPORTED",
      entity: "vehicle",
      metadata: { count: out.length, projectIds: [...new Set(out.map((o) => o.v.projectId).filter(Boolean))] },
    });
    return out;
  });
  res.status(201).json({
    data: {
      count: created.length,
      vehicles: created.map(({ v, projectName }) => ({ id: v.id, plateNumber: v.plateNumber, make: v.make, model: v.model, year: v.year, projectName })),
    },
  });
});
