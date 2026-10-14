import "./_script-env.js";
import { config } from "../config.js";
import { syncCatalog } from "../db/bootstrap.js";
import { db, pool } from "../db/client.js";
import { databaseIdentity } from "../lib/db-identity.js";
import { applyInit, certify, collectPlan, DESIGNATION_COMMENT, evaluateGuards, maskEmail, parseFlags, type Plan } from "../services/db-init.js";
import { createStorageFromConfig } from "../services/storage.js";

/**
 * Initialize / certify a NEW production database (see docs/PRODUCTION-INITIALIZATION.md).
 *
 *   node dist/scripts/init-production-db.js                     report only (default): nothing is changed
 *   node dist/scripts/init-production-db.js --apply …           empty the operational tables — only when every guard passes
 *
 * It never connects anywhere but DATABASE_URL, never prints credentials, never drops or alters schema objects, and refuses
 * Render databases, databases that are not explicitly designated, and databases with rows in the append-only tables.
 */
const flags = parseFlags(process.argv.slice(2));
const identity = databaseIdentity(config.DATABASE_URL);
const line = (s = "") => console.log(s);

function printReport(plan: Plan) {
  line("=== Easy Fleet — production database initialization report ===");
  line(`database     : ${plan.identity.database}`);
  line(`host         : ${plan.identity.host}:${plan.identity.port}`);
  line(`environment  : ${plan.environment}`);
  line(`designated   : ${plan.designated ? "yes" : `no (needed for --apply: COMMENT ON DATABASE … IS '${DESIGNATION_COMMENT}')`}`);
  line(`organization : "${plan.organization.name}"${plan.organization.looksDemo ? "   <- carries demo values, would be reset" : ""}`);
  line();
  line("table                             rows  action");
  for (const t of plan.tables) line(`${t.name.padEnd(32)}${String(t.rows).padStart(6)}  ${t.action === "CLEAN" ? (t.rows ? "WILL BE EMPTIED" : "clean (already empty)") : t.action === "PRESERVE" ? "kept (catalog: re-synced from code)" : t.rows ? "PROTECTED append-only — cannot be emptied" : "protected append-only (empty)"}`);
  line();
  line(`administrators (SUPER_ADMIN): ${plan.admins.length ? plan.admins.map((a) => `${maskEmail(a.email)} (${a.name})`).join(", ") : "none — create one with `node dist/scripts/bootstrap.js` (BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD_FILE)"}`);
  line(`uploaded files: ${plan.files.rows} row(s), ${plan.files.bytes} bytes, storage provider "${plan.files.provider}"${plan.files.rows ? "  (objects are deleted only with --delete-files, only the keys listed in the files table)" : ""}`);
  line(`demo markers   : ${Object.entries(plan.demo).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  const c = certify(plan);
  line();
  line(`CLEAN CHECK: ${c.pass ? "PASS — no demo data, no operational data" : `FAIL — ${c.failures.join("; ")}`}`);
  line(`PLAN HASH  : ${plan.hash}`);
}

try {
  const plan = await collectPlan(pool, identity, { environment: config.NODE_ENV, storageProvider: config.STORAGE_PROVIDER });
  printReport(plan);
  const guards = evaluateGuards(plan, flags, process.env);
  line();
  line(flags.apply ? "guards for --apply:" : "guards an --apply would need (nothing is changed in this mode):");
  for (const g of guards) line(`  [${g.ok ? "ok" : "--"}] ${g.id}${g.ok ? "" : `: ${g.why}`}`);
  if (!flags.apply) {
    line();
    line(certify(plan).pass ? "Nothing to clean. This database is ready for real data (create the administrator with bootstrap)." : "STOPPED after the report. Nothing was changed. Review it, then re-run with --apply and the guard flags.");
  } else {
    const failed = guards.filter((g) => !g.ok);
    if (failed.length) {
      console.error(`\nREFUSED: ${failed.length} guard(s) failed — nothing was changed.`);
      process.exitCode = 2;
    } else {
      const result = await applyInit(pool, plan, flags);
      await syncCatalog(db); // idempotent: the catalog is exactly what the code declares
      let objects = { deleted: 0, failed: 0 };
      if (flags.deleteFiles && result.fileKeys.length) {
        const storage = createStorageFromConfig();
        for (const key of result.fileKeys) await storage.remove(key).then(() => objects.deleted++, () => objects.failed++);
      }
      const cleared = await pool.query(`comment on database ${`"${plan.identity.database.replace(/"/g, '""')}"`} is null`).then(() => true, () => false);
      const after = await collectPlan(pool, identity, { environment: config.NODE_ENV, storageProvider: config.STORAGE_PROVIDER });
      line();
      line(`DONE: ${result.truncated.length} tables emptied${result.keptAdmin ? `, administrator kept: ${maskEmail(result.keptAdmin)}` : ""}${result.orgNormalized ? ", organization reset" : ""}; file objects deleted: ${objects.deleted}${objects.failed ? ` (failed: ${objects.failed})` : ""}.`);
      line(`designation marker ${cleared ? "cleared (this tool cannot run again until the owner sets it)" : "NOT cleared — remove it yourself: COMMENT ON DATABASE … IS NULL"}.`);
      const c = certify(after);
      line(`CLEAN CHECK after: ${c.pass ? "PASS" : `FAIL — ${c.failures.join("; ")}`}`);
      if (!result.keptAdmin) line("Next: create the SUPER_ADMIN with `node dist/scripts/bootstrap.js` (password from a secret file), then remove the BOOTSTRAP_* settings.");
      if (!c.pass || objects.failed) process.exitCode = 3;
    }
  }
} catch (e) {
  console.error(`init-production-db failed: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://***") : "error"}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
