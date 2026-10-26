import { and, eq, inArray, or } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { Access } from "../../auth/access.js";
import type { DbOrTx } from "../../db/client.js";
import { projects, vehicles } from "../../db/schema/index.js";
import { HttpError, friendlyIssue, type IssueLike } from "../../http/errors.js";
import { tr, translateText } from "../../i18n/index.js";
import { authorizeVehicleTarget, checkWarranty, VehicleBody, type VehicleInput } from "./create.js";
import {
  fixYeh,
  FUEL_NOTE_PREFIX,
  FUEL_TYPES,
  FUEL_TYPOS,
  IMPORT_COLUMNS,
  INSTRUCTIONS_SHEET,
  MAX_IMPORT_ROWS,
  SHEET_NAME,
  STATUS_CHOICES,
  STATUS_LABELS,
  type ImportColumn,
  yehForMatch,
} from "./import-spec.js";

/** A problem with the file as a whole (not a row): wrong format, empty, too big, missing columns. */
const fileError = (message: string) => new HttpError(400, "IMPORT_FILE_INVALID", message);

// ------------------------------------------------------------------ zip sanity (before the workbook is loaded)

const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_UNCOMPRESSED = 30 * 1024 * 1024;

/**
 * An .xlsx is a zip. Reads the central directory (sizes the archive declares) and rejects archives that would expand
 * far beyond a spreadsheet of MAX_IMPORT_ROWS rows, before any decompression happens.
 */
export function inspectXlsxContainer(buf: Buffer): void {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw fileError(tr("الملف ليس ملف Excel (.xlsx) صالحًا"));
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fileError(tr("الملف ليس ملف Excel (.xlsx) صالحًا"));
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_ZIP_ENTRIES) throw fileError(tr("محتوى الملف غير متوقع لملف Excel"));
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fileError(tr("الملف ليس ملف Excel (.xlsx) صالحًا"));
    total += buf.readUInt32LE(p + 24);
    if (total > MAX_ZIP_UNCOMPRESSED) throw fileError(tr("محتوى الملف أكبر من المسموح"));
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

// ------------------------------------------------------------------ cell / text normalization

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const ARABIC_DIGITS = /[٠-٩]/g;
const toLatinDigits = (s: string) => s.replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));

/** trim, drop invisible direction marks, collapse whitespace. Never changes the letters. */
const clean = (s: string) => s.normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
/** Matching form of a project name: whitespace, direction marks, yeh/maqsura, tatweel and case. */
const matchKey = (s: string) => yehForMatch(clean(s)).replace(/\u0640/g, "").toLowerCase();

type Cell = { text?: string; date?: string; error?: string };

function readCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return {};
  if (typeof v === "string") return { text: v };
  if (typeof v === "number") return { text: Number.isFinite(v) ? String(v) : undefined };
  if (typeof v === "boolean") return { error: tr("قيمة غير مدعومة في الخلية") };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { error: tr("تاريخ غير صالح") } : { date: v.toISOString().slice(0, 10), text: v.toISOString().slice(0, 10) };
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("formula" in o || "sharedFormula" in o) return { error: tr("الصيغ (Formulas) غير مسموحة، أدخل القيمة نفسها") };
    if ("error" in o) return { error: tr("الخلية تحتوي خطأ") };
    if (Array.isArray(o.richText)) return { text: (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("") };
    if (typeof o.text === "string") return { text: o.text };
  }
  return { error: tr("قيمة غير مدعومة في الخلية") };
}

/** Text that a spreadsheet application would execute when the cell is opened again. */
const FORMULA_START = /^[=+@\t\r]/;

// ------------------------------------------------------------------ parsing

export type ParsedRow = {
  /** Excel row number (the header is row 1). */
  row: number;
  values: Record<string, string | undefined>;
  errors: string[];
};

export async function parseWorkbook(buf: Buffer): Promise<ParsedRow[]> {
  inspectXlsxContainer(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw fileError(tr("تعذر قراءة الملف، تأكد أنه ملف Excel (.xlsx) سليم"));
  }
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets.find((w) => w.name !== INSTRUCTIONS_SHEET) ?? wb.worksheets[0];
  if (!ws || ws.rowCount < 1) throw fileError(tr("الملف فارغ"));

  // header row → column index per known column
  const byHeader = new Map<string, ImportColumn>();
  for (const c of IMPORT_COLUMNS) for (const h of [c.header, ...(c.aliases ?? [])]) byHeader.set(matchKey(h), c);
  const colIndex = new Map<string, number>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, n) => {
    const c = byHeader.get(matchKey(readCell(cell.value).text ?? ""));
    if (c && !colIndex.has(c.key)) colIndex.set(c.key, n);
  });
  const missing = IMPORT_COLUMNS.filter((c) => c.required && !colIndex.has(c.key)).map((c) => c.header);
  if (missing.length) throw fileError(tr("أعمدة مطلوبة غير موجودة في الملف: {0}", missing.join("، ")));
  if (ws.rowCount - 1 > MAX_IMPORT_ROWS * 4) throw fileError(tr("عدد الصفوف كبير جدًا، الحد الأقصى {0} مركبة في الملف الواحد", MAX_IMPORT_ROWS));

  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const wr = ws.getRow(r);
    const values: Record<string, string | undefined> = {};
    const errors: string[] = [];
    let any = false;
    for (const c of IMPORT_COLUMNS) {
      const n = colIndex.get(c.key);
      if (!n) continue;
      const cell = readCell(wr.getCell(n).value);
      if (cell.error) {
        errors.push(`${c.header}: ${cell.error}`);
        any = true;
        continue;
      }
      let text = cell.text === undefined ? undefined : clean(cell.text);
      if (text === undefined || text === "") continue;
      any = true;
      if (text.length > 2100) {
        errors.push(`${c.header}: ${tr("النص طويل جدًا")}`);
        continue;
      }
      if (FORMULA_START.test(text)) {
        errors.push(`${c.header}: ${tr("القيمة تبدأ بحرف غير مسموح (= + @)")}`);
        continue;
      }
      if (c.kind === "int" || c.kind === "money") text = toLatinDigits(text);
      if (c.kind === "date") text = toLatinDigits(text).replace(/\//g, "-");
      if (c.kind === "money") text = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, "") : text;
      values[c.key] = text;
    }
    if (any) rows.push({ row: r, values, errors });
  }
  if (rows.length === 0) throw fileError(tr("الملف لا يحتوي على أي صف مركبات"));
  if (rows.length > MAX_IMPORT_ROWS) throw fileError(tr("عدد الصفوف كبير جدًا، الحد الأقصى {0} مركبة في الملف الواحد", MAX_IMPORT_ROWS));
  return rows;
}

// ------------------------------------------------------------------ validation

export type ReportRow = {
  row: number;
  plateNumber: string;
  make: string;
  model: string;
  year: string;
  projectName: string;
  valid: boolean;
  errors: string[];
  /** Obvious spelling fixes applied, shown in the preview ("سوزوكى → سوزوكي"). */
  notices: string[];
};

export type ImportReport = { total: number; valid: number; invalid: number; rows: ReportRow[] };

export type PlannedVehicle = { row: number; body: VehicleInput; projectName: string };

/** Sequential map: one project authorization query at a time, rows in file order. */
async function mapSeq<T, R>(list: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of list) out.push(await fn(item));
  return out;
}

const label = (key: string) => IMPORT_COLUMNS.find((c) => c.key === key)?.header ?? key;

/**
 * Validates every row with the same rules as POST /vehicles (VehicleBody, warranty check, project authorization,
 * uniqueness) and plans the inserts. Reads only; nothing is written. The project always comes from the name in the
 * file, resolved inside the caller's organization, then authorized exactly like a normal vehicle creation.
 */
export async function validateImport(db: DbOrTx, access: Access, parsed: ParsedRow[]): Promise<{ report: ImportReport; planned: PlannedVehicle[] }> {
  // organization projects by normalized name (a name that matches two projects is ambiguous → rejected)
  const orgProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.organizationId, access.orgId));
  const projectsByName = new Map<string, { id: string; name: string }[]>();
  for (const p of orgProjects) projectsByName.set(matchKey(p.name), [...(projectsByName.get(matchKey(p.name)) ?? []), p]);
  const projectVerdict = new Map<string, string | null>(); // project id → error message (null = allowed)

  const items = parsed.map((p) => {
    const notices: string[] = [];
    const errors = [...p.errors];
    const v = p.values;
    const fixed = (key: string) => {
      const raw = v[key];
      if (raw === undefined) return undefined;
      const out = fixYeh(raw);
      if (out !== raw) notices.push(`${label(key)}: ${raw} → ${out}`);
      return out;
    };

    const candidate: Record<string, unknown> = {};
    const put = (key: string, value: unknown) => value !== undefined && (candidate[key] = value);
    put("plateNumber", v.plateNumber);
    put("plateArabic", v.plateArabic);
    put("plateEnglish", v.plateEnglish);
    put("serialNumber", v.serialNumber);
    put("vehicleNumber", v.vehicleNumber);
    put("vin", v.vin);
    put("make", fixed("make"));
    put("model", fixed("model"));
    put("year", v.year);
    put("color", fixed("color"));
    put("currentOdometer", v.currentOdometer);
    put("purchaseDate", v.purchaseDate);
    put("purchasePrice", v.purchasePrice);
    put("warrantyStart", v.warrantyStart);
    put("warrantyEnd", v.warrantyEnd);
    put("nextServiceDate", v.nextServiceDate);
    put("nextServiceOdometer", v.nextServiceOdometer);
    put("nextOilChangeDate", v.nextOilChangeDate);
    put("nextOilChangeOdometer", v.nextOilChangeOdometer);

    // status: UI labels or enum keys; anything else is an error (never guessed)
    if (v.status !== undefined) {
      const s = STATUS_LABELS[fixYeh(v.status)] ?? (["AVAILABLE", "OUT_OF_SERVICE", "SOLD"].includes(v.status.toUpperCase()) ? v.status.toUpperCase() : undefined);
      if (s) candidate.status = s;
      else errors.push(`${label("status")}: ${tr("حالة غير صالحة، المسموح: {0}", STATUS_CHOICES.join("، "))}`);
    }

    // fuel type: validated, then kept in the notes (the vehicle schema has no fuel column)
    let notes = v.notes;
    if (v.fuelType !== undefined) {
      const f = fixYeh(FUEL_TYPOS[fixYeh(v.fuelType)] ?? v.fuelType);
      if (f !== v.fuelType) notices.push(`${label("fuelType")}: ${v.fuelType} → ${f}`);
      if (FUEL_TYPES.includes(f)) notes = notes ? `${FUEL_NOTE_PREFIX}${f}\n${notes}` : `${FUEL_NOTE_PREFIX}${f}`;
      else errors.push(`${label("fuelType")}: ${tr("نوع وقود غير معروف، المسموح: {0}", FUEL_TYPES.join("، "))}`);
    }
    put("notes", notes);

    // project by name inside the organization
    let projectId: string | undefined;
    const projectName = v.project ? clean(v.project) : "";
    if (projectName) {
      const hits = projectsByName.get(matchKey(projectName)) ?? [];
      if (hits.length > 1) errors.push(`${label("project")}: ${tr("اسم المشروع يطابق أكثر من مشروع، أعد تسميته ثم أعد المحاولة")}`);
      else if (hits.length === 0) errors.push(`${label("project")}: ${tr("المشروع غير موجود أو لا تملك صلاحية الإضافة إليه")}`);
      else projectId = hits[0]!.id;
    }
    if (projectId) candidate.projectId = projectId;
    return { p, notices, errors, candidate, projectId, projectName: projectId ? (projectsByName.get(matchKey(projectName))![0]!.name) : projectName };
  });

  // schema validation (same as POST /vehicles), warranty rule, project authorization
  const results = await mapSeq(
    items,
    async (it) => {
      const errors = [...it.errors];
      const parsedBody = VehicleBody.safeParse(it.candidate);
      let body: VehicleInput | null = null;
      if (!parsedBody.success) {
        for (const issue of parsedBody.error.issues) {
          const key = String(issue.path[0] ?? "");
          errors.push(`${label(key)}: ${translateText(friendlyIssue(issue as unknown as IssueLike))}`);
        }
      } else {
        body = parsedBody.data;
        try {
          checkWarranty(body);
        } catch (e) {
          if (e instanceof HttpError) errors.push(`${label("warrantyEnd")}: ${e.message}`);
          else throw e;
        }
        if (it.projectId || !it.projectName) {
          // The project-less case follows the normal rule too (only an ALL-scope creator may leave it empty).
          const verdictKey = it.projectId ?? "";
          if (!projectVerdict.has(verdictKey)) {
            try {
              await authorizeVehicleTarget(db, access, it.projectId ?? null);
              projectVerdict.set(verdictKey, null);
            } catch (e) {
              if (!(e instanceof HttpError)) throw e;
              projectVerdict.set(verdictKey, it.projectId ? tr("المشروع غير موجود أو لا تملك صلاحية الإضافة إليه") : e.message);
            }
          }
          const denied = projectVerdict.get(verdictKey);
          if (denied) errors.push(`${label("project")}: ${denied}`);
        }
      }
      return { ...it, errors, body };
    },
  );

  // uniqueness: inside the file, then against the organization (archived vehicles included: the DB rule ignores status)
  const seen = { plate: new Map<string, number>(), number: new Map<string, number>(), vin: new Map<string, number>() };
  const dupes = (kind: keyof typeof seen, value: string | null | undefined, row: number, msg: string, errors: string[]) => {
    if (!value) return;
    const first = seen[kind].get(value);
    if (first !== undefined) errors.push(`${msg} — ${tr("مكرر داخل الملف (الصف {0})", first)}`);
    else seen[kind].set(value, row);
  };
  for (const r of results) {
    dupes("plate", r.body?.plateNumber ?? r.candidate.plateNumber as string | undefined, r.p.row, label("plateNumber"), r.errors);
    dupes("number", r.body?.vehicleNumber, r.p.row, label("vehicleNumber"), r.errors);
    dupes("vin", r.body?.vin, r.p.row, label("vin"), r.errors);
  }
  const plates = results.map((r) => r.body?.plateNumber).filter((x): x is string => !!x);
  const numbers = results.map((r) => r.body?.vehicleNumber).filter((x): x is string => !!x);
  const vins = results.map((r) => r.body?.vin).filter((x): x is string => !!x);
  const clauses = [plates.length ? inArray(vehicles.plateNumber, plates) : undefined, numbers.length ? inArray(vehicles.vehicleNumber, numbers) : undefined, vins.length ? inArray(vehicles.vin, vins) : undefined].filter((x) => x !== undefined);
  const existing = clauses.length
    ? await db.select({ plate: vehicles.plateNumber, number: vehicles.vehicleNumber, vin: vehicles.vin }).from(vehicles).where(and(eq(vehicles.organizationId, access.orgId), or(...clauses)))
    : [];
  const exPlate = new Set(existing.map((e) => e.plate));
  const exNumber = new Set(existing.map((e) => e.number).filter(Boolean));
  const exVin = new Set(existing.map((e) => e.vin).filter(Boolean));
  for (const r of results) {
    if (r.body && exPlate.has(r.body.plateNumber)) r.errors.push(`${label("plateNumber")}: ${tr("توجد مركبة بنفس رقم اللوحة مسبقًا")}`);
    if (r.body?.vehicleNumber && exNumber.has(r.body.vehicleNumber)) r.errors.push(`${label("vehicleNumber")}: ${tr("توجد مركبة بنفس الرقم الداخلي مسبقًا")}`);
    if (r.body?.vin && exVin.has(r.body.vin)) r.errors.push(`${label("vin")}: ${tr("توجد مركبة بنفس رقم الهيكل مسبقًا")}`);
  }

  const rows: ReportRow[] = results.map((r) => ({
    row: r.p.row,
    plateNumber: r.p.values.plateNumber ?? "",
    make: r.body?.make ?? (r.candidate.make as string | undefined) ?? "",
    model: r.body?.model ?? (r.candidate.model as string | undefined) ?? "",
    year: r.p.values.year ?? "",
    projectName: r.projectName,
    valid: r.errors.length === 0,
    errors: r.errors,
    notices: r.notices,
  }));
  const planned: PlannedVehicle[] = results.filter((r) => r.errors.length === 0 && r.body).map((r) => ({ row: r.p.row, body: r.body!, projectName: r.projectName }));
  const valid = rows.filter((r) => r.valid).length;
  return { report: { total: rows.length, valid, invalid: rows.length - valid, rows }, planned };
}
