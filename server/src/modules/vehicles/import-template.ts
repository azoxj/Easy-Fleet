import ExcelJS from "exceljs";
import { FUEL_TYPES, IMPORT_COLUMNS, INSTRUCTIONS_SHEET, MAX_IMPORT_ROWS, SHEET_NAME, STATUS_CHOICES } from "./import-spec.js";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
const TEXT_KEYS = new Set(["plateNumber", "plateArabic", "plateEnglish", "serialNumber", "vehicleNumber", "vin", "make", "model", "fuelType", "project", "color", "status", "notes"]);

/** Builds the .xlsx a user fills in. `rows` (column key → value) is optional sample data. */
export async function buildImportWorkbook(rows: Record<string, string | number>[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Easy Fleet";
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 6) }));
  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((cell, n) => {
    const col = IMPORT_COLUMNS[n - 1]!;
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    if (col.required) cell.font = { bold: true, color: { argb: "FFFFD966" } };
  });
  const last = MAX_IMPORT_ROWS + 1;
  IMPORT_COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (TEXT_KEYS.has(c.key)) col.numFmt = "@";
    if (c.kind === "date") col.numFmt = "yyyy-mm-dd";
  });
  const choices = (key: string, list: string[]) => {
    const n = IMPORT_COLUMNS.findIndex((c) => c.key === key) + 1;
    for (let r = 2; r <= last; r++) ws.getCell(r, n).dataValidation = { type: "list", allowBlank: true, formulae: [`"${list.join(",")}"`] };
  };
  // sample rows first: addRow appends after the last cell that exists, and the choice lists create cells down to MAX rows
  rows.forEach((row) => ws.addRow(IMPORT_COLUMNS.map((c) => row[c.key] ?? null)));
  choices("status", STATUS_CHOICES);
  choices("fuelType", FUEL_TYPES);

  const help = wb.addWorksheet(INSTRUCTIONS_SHEET, { views: [{ rightToLeft: true }] });
  help.getColumn(1).width = 110;
  [
    "تعليمات استيراد المركبات",
    `الأعمدة المطلوبة (بالأصفر): ${IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.header).join("، ")}. بقية الأعمدة اختيارية ولا تُملأ تلقائيًا.`,
    "المشروع: اكتب اسم المشروع كما هو في النظام. يُرفض الصف إذا لم يوجد المشروع أو لم تكن لك صلاحية الإضافة إليه.",
    `الحالة: ${STATUS_CHOICES.join("، ")} (أو اتركها فارغة). نوع الوقود: ${FUEL_TYPES.join("، ")} ويُحفظ ضمن الملاحظات.`,
    "التواريخ بصيغة YYYY-MM-DD. لا تستخدم الصيغ (Formulas) ولا تبدأ الخلية بـ = أو + أو @.",
    `يُفحص الملف كاملًا قبل الحفظ: إن وُجد صف غير صالح لا تُضاف أي مركبة. الحد الأقصى ${MAX_IMPORT_ROWS} صف و2 ميجابايت.`,
    "لا يُسمح بتكرار رقم اللوحة أو الرقم الداخلي أو رقم الهيكل داخل الملف أو مع مركبة موجودة.",
  ].forEach((line, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = line;
    cell.alignment = { wrapText: true, vertical: "top" };
    if (i === 0) cell.font = { bold: true, size: 14 };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
