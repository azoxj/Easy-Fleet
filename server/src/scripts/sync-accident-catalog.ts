import "./_script-env.js";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, pool } from "../db/client.js";
import { databaseIdentity } from "../lib/db-identity.js";
import { applyAccidentCatalogPlan, assertPlanScope, isEmptyPlan, planAccidentCatalog, readCatalogState, type AccidentCatalogPlan } from "../services/accident-catalog-sync.js";

/**
 * Adds the accident permissions and roles WITHOUT the general catalog sync (which rewrites every system role).
 *
 *   node dist/scripts/sync-accident-catalog.js                      preview only (default): a READ ONLY transaction
 *   node dist/scripts/sync-accident-catalog.js --include-technical  preview including the two TECHNICAL additions
 *   node dist/scripts/sync-accident-catalog.js --include-project-manager-sensitive
 *                                                                  preview including the ONE PROJECT_MANAGER grant
 *                                                                  (accidents.documents.sensitive, PROJECT); the rest of that role is left alone
 *   … --apply --plan-hash=<hash from the preview> [--include-technical]   with EF_CONFIRM_ACCIDENT_CATALOG=yes
 *
 * Insert-only. It never removes or changes a grant. PROJECT_MANAGER is only touched by --include-project-manager-sensitive, and then
 * only that one grant is added; its other (pending) differences from the code stay as they are.
 * Prints keys and scopes only, never connection details.
 */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const includeTechnical = args.includes("--include-technical");
const includePmSensitive = args.includes("--include-project-manager-sensitive");
const hashArg = args.find((a) => a.startsWith("--plan-hash="))?.slice("--plan-hash=".length);
const id = databaseIdentity(config.DATABASE_URL);

function print(plan: AccidentCatalogPlan) {
  console.log(`database: ${id.database} (${id.host})`);
  console.log(`permissions to create (${plan.permissionsToCreate.length}): ${plan.permissionsToCreate.join(", ") || "-"}`);
  console.log(`roles to create (${plan.rolesToCreate.length}): ${plan.rolesToCreate.join(", ") || "-"}`);
  console.log(`grants to add (${plan.grantsToAdd.length}):`);
  for (const g of plan.grantsToAdd) console.log(`  + ${g.role}: ${g.permission} (${g.scope})`);
  for (const l of plan.leftAsIs) console.log(`  = ${l}`);
  console.log(plan.includeProjectManagerSensitive ? "PROJECT_MANAGER: only accidents.documents.sensitive (PROJECT) may be added; every other grant of that role is left exactly as it is (its pending differences are NOT applied)." : "PROJECT_MANAGER and every other system role: not touched, no grant added, changed or removed.");
  console.log(`PLAN HASH: ${plan.hash}`);
}

try {
  const preview = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return planAccidentCatalog(await readCatalogState(tx), { includeTechnical, includeProjectManagerSensitive: includePmSensitive });
  });
  assertPlanScope(preview);
  print(preview);
  if (!apply) {
    console.log("\n[sync-accident-catalog] preview only: nothing was written.");
  } else {
    const guards = [
      { ok: process.env.EF_CONFIRM_ACCIDENT_CATALOG === "yes", why: "set EF_CONFIRM_ACCIDENT_CATALOG=yes" },
      { ok: !!hashArg && hashArg === preview.hash, why: `--plan-hash must equal ${preview.hash} (the plan you reviewed; the state may have changed)` },
      { ok: !/(^|\.)render\.com$|onrender\.com$|^dpg-/i.test(id.host), why: "Render databases are never changed by this tool" },
    ];
    const failed = guards.filter((g) => !g.ok);
    if (failed.length) {
      for (const g of failed) console.error(`REFUSED: ${g.why}`);
      console.error("Nothing was written.");
      process.exitCode = 2;
    } else if (isEmptyPlan(preview)) {
      console.log("\nNothing to do: the accident catalog is already in place.");
    } else {
      await db.transaction((tx) => applyAccidentCatalogPlan(tx, preview));
      console.log("\nApplied (insert-only, verified inside the transaction).");
    }
  }
} catch (e) {
  console.error(`sync-accident-catalog failed: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://***") : "error"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
