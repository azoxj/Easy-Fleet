# Bulk vehicle import (Excel)

Vehicles page → **استيراد مركبات**: download the template, fill it, upload it, review the preview, confirm.

## Endpoints (all need `vehicles.create`, the permission of "add vehicle")
| Endpoint | Does |
|---|---|
| `GET /api/vehicles/import/template` | the template workbook (columns below, a help sheet, choice lists) |
| `POST /api/vehicles/import/preview` | validates the whole file, writes nothing, returns per-row results |
| `POST /api/vehicles/import/commit` | validates again, then creates every vehicle in **one transaction** (all or nothing) |

The body is the raw `.xlsx` (`X-File-Name` must end in `.xlsx`). Limits: 2 MB, 500 rows. The browser never sends a project id.

## How a row is checked
- Same rules as `POST /vehicles`: the `VehicleBody` schema, the warranty order check, `authorizeVehicleTarget` (project authorization: a project manager only into projects he belongs to, a row without a project only for an ALL-scope creator), then `insertVehicle` (the same insert, audit record and project-manager notification).
- The project column is **optional**. The project is found **by name inside the caller's organization** (never an id from the file) and authorized exactly like a normal creation.
  - found and allowed → the vehicle is linked ("مرتبط بالمشروع" in the preview);
  - not found, ambiguous (two projects with that name), or not allowed → the vehicle is imported **without a project** (`project_id` = null), the preview says "سيتم استيراد المركبة بدون مشروع" with the reason, and the name from the file is kept in the notes as `المشروع الأصلي من ملف الاستيراد: <name>` so the vehicle can be assigned later from the Vehicles screen. No project is ever created.
  - This fallback exists only for a creator who may add a vehicle without a project (the `POST /vehicles` rule: `vehicles.create` with ALL scope, i.e. SUPER_ADMIN). A PROJECT_MANAGER may not, so his rows with a missing, foreign or empty project are rejected with that reason, and nothing is imported.
- Duplicates (plate number, internal number, VIN): inside the file and against existing vehicles of the organization, archived ones included (the database rule ignores status).
- Any invalid row → nothing is created (`422 IMPORT_VALIDATION_FAILED` with the full report).
- Obvious spelling fixes only (shown in the preview): final alef-maqsura for yeh in make/model/colour/fuel (`سوزوكى → سوزوكي`) and fuel typos (`بنزبن → بنزين`). Plate, VIN, numbers and project are never rewritten (project matching ignores whitespace and ى/ي).
- Formulas, error cells and text starting with `= + @` are rejected. The workbook is inspected (entry count and declared size) before it is opened.

## Columns
`رقم اللوحة` (required) · `رقم اللوحة بالعربي` · `اللوحة بالإنجليزي` · `الرقم التسلسلي (الاستمارة)` · `رقم المركبة الداخلي` · `رقم الهيكل (VIN)` · `الشركة المصنعة` (required) · `الطراز` (required) · `سنة الصنع` · `نوع الوقود` · `المشروع` · `قراءة العداد (كم)` · `اللون` · `الحالة` · `تاريخ الشراء` · `سعر الشراء (ريال)` · `بداية الضمان` · `نهاية الضمان` · `موعد الصيانة القادمة` · `الصيانة القادمة عند العداد (كم)` · `موعد تغيير الزيت القادم` · `تغيير الزيت عند العداد (كم)` · `ملاحظات`

Only plate number, make and model are required (as in the vehicle form). Empty optional cells stay empty.

**Fuel type:** the vehicle schema has no fuel column (and no migration was made). A valid value (بنزين، ديزل، هجين، كهرباء، غاز) is kept at the start of the vehicle notes as `نوع الوقود: …`. A real column would need a migration.

## Prepared files (`docs/vehicle-import/`)
- `vehicle-import-template.xlsx`: empty template.
- `vehicle-import-25-vehicles.xlsx`: the 25 vehicles, with the city and the company in the notes (`المدينة: … — الجهة: …`). The project names must exist in the system before the file is imported; unknown projects are rejected row by row.
- Regenerate: `cd server && npx tsx src/scripts/make-vehicle-import-files.ts` (no database needed).
