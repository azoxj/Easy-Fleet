/**
 * Column contract of the vehicle import template. The headers are the Arabic column names users see in Excel;
 * they are data (not UI messages), so they are never passed through the request-locale translation.
 */
export type ColumnKind = "text" | "int" | "money" | "date";

export type ImportColumn = {
  key: string;
  header: string;
  kind: ColumnKind;
  /** Required by the existing vehicle schema (plate number, make, model). */
  required?: boolean;
  /** Other spellings accepted for the header (never written to the template). */
  aliases?: string[];
};

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: "plateNumber", header: "رقم اللوحة", kind: "text", required: true },
  { key: "plateArabic", header: "رقم اللوحة بالعربي", kind: "text", aliases: ["اللوحة بالعربي"] },
  { key: "plateEnglish", header: "اللوحة بالإنجليزي", kind: "text" },
  { key: "serialNumber", header: "الرقم التسلسلي (الاستمارة)", kind: "text" },
  { key: "vehicleNumber", header: "رقم المركبة الداخلي", kind: "text" },
  { key: "vin", header: "رقم الهيكل (VIN)", kind: "text" },
  { key: "make", header: "الشركة المصنعة", kind: "text", required: true },
  { key: "model", header: "الطراز", kind: "text", required: true },
  { key: "year", header: "سنة الصنع", kind: "int" },
  { key: "fuelType", header: "نوع الوقود", kind: "text" },
  { key: "project", header: "المشروع", kind: "text" },
  { key: "currentOdometer", header: "قراءة العداد (كم)", kind: "int" },
  { key: "color", header: "اللون", kind: "text" },
  { key: "status", header: "الحالة", kind: "text" },
  { key: "purchaseDate", header: "تاريخ الشراء", kind: "date" },
  { key: "purchasePrice", header: "سعر الشراء (ريال)", kind: "money" },
  { key: "warrantyStart", header: "بداية الضمان", kind: "date" },
  { key: "warrantyEnd", header: "نهاية الضمان", kind: "date" },
  { key: "nextServiceDate", header: "موعد الصيانة القادمة", kind: "date" },
  { key: "nextServiceOdometer", header: "الصيانة القادمة عند العداد (كم)", kind: "int" },
  { key: "nextOilChangeDate", header: "موعد تغيير الزيت القادم", kind: "date" },
  { key: "nextOilChangeOdometer", header: "تغيير الزيت عند العداد (كم)", kind: "int" },
  { key: "notes", header: "ملاحظات", kind: "text" },
];

export const SHEET_NAME = "المركبات";
export const INSTRUCTIONS_SHEET = "تعليمات";

/** Statuses a user may set by hand, by the labels the UI shows (and the enum keys). */
export const STATUS_LABELS: Record<string, "AVAILABLE" | "OUT_OF_SERVICE" | "SOLD"> = {
  "متاحة": "AVAILABLE",
  "متاح": "AVAILABLE",
  "خارج الخدمة": "OUT_OF_SERVICE",
  "مباعة": "SOLD",
  "مباع": "SOLD",
};
export const STATUS_CHOICES = ["متاحة", "خارج الخدمة", "مباعة"];

/** The schema has no fuel-type column: a valid value is kept in the vehicle notes ("نوع الوقود: …"). */
export const FUEL_TYPES = ["بنزين", "ديزل", "هجين", "كهرباء", "غاز"];
/** Obvious typos only; anything else is rejected, never guessed. */
export const FUEL_TYPOS: Record<string, string> = { "بنزبن": "بنزين", "بنزن": "بنزين", "ديزيل": "ديزل" };
export const FUEL_NOTE_PREFIX = "نوع الوقود: ";
/** A project named in the file that could not be linked is kept in the notes under this prefix. */
export const ORIGINAL_PROJECT_PREFIX = "المشروع الأصلي من ملف الاستيراد: ";

export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Arabic final alef-maqsura written for yeh (سوزوكى → سوزوكي), used for make/model/colour/fuel only. */
export const fixYeh = (s: string) => s.replace(/ى(?=\s|$)/g, "ي");
/** Every alef-maqsura read as yeh, for comparing names (never used to rewrite stored values). */
export const yehForMatch = (s: string) => s.replace(/ى/g, "ي");
