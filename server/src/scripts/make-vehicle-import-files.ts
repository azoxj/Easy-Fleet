import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildImportWorkbook } from "../modules/vehicles/import-template.js";
import { SAMPLE_VEHICLES } from "./vehicle-import-sample-data.js";

/** Writes the empty template and the 25-vehicle sample next to the docs (no database, no network). */
const dir = path.resolve(process.argv[2] ?? "../docs/vehicle-import");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "vehicle-import-template.xlsx"), await buildImportWorkbook());
writeFileSync(path.join(dir, "vehicle-import-25-vehicles.xlsx"), await buildImportWorkbook(SAMPLE_VEHICLES));
console.log(`written to ${dir}`);
