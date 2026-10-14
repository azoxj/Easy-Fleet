import "./_script-env.js";
import { S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { schemaStatus, readJournal } from "../db/migrations.js";
import { databaseIdentity, demoSeedBlockReason } from "../lib/db-identity.js";
import { inspectBucket } from "../services/aws-verify.js";
import { certify, collectPlan } from "../services/db-init.js";

/**
 * Read-only verification of a freshly provisioned AWS environment (see docs/AWS-INITIAL-VERIFICATION.md).
 * Every database statement runs inside a READ ONLY transaction that is always rolled back; the bucket is only listed.
 * It connects to DATABASE_URL and the configured S3 bucket and nothing else, and prints no credentials.
 */
const line = (s = "") => console.log(s);
const identity = databaseIdentity(config.DATABASE_URL);
const RENDER_HOST = /(^|\.)render\.com$|onrender\.com$|^dpg-/i;
let failed = false;
const verdict = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed = true;
  line(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const client = await pool.connect();
try {
  await client.query("begin read only");
  line("=== Easy Fleet — AWS read-only verification ===");
  line(`endpoint     : ${identity.host}:${identity.port}`);
  line(`database     : ${identity.database}`);
  line(`environment  : ${config.NODE_ENV}`);
  const dbs = (await client.query<{ datname: string }>(`select datname from pg_database where not datistemplate and datallowconn order by 1`)).rows.map((r) => r.datname);
  line(`databases visible on the server: ${dbs.join(", ")}`);
  line();

  const plan = await collectPlan(client, identity, { environment: config.NODE_ENV, storageProvider: config.STORAGE_PROVIDER });
  line("table                             rows  kind");
  for (const t of plan.tables) line(`${t.name.padEnd(32)}${String(t.rows).padStart(6)}  ${t.action === "PRESERVE" ? "catalog" : t.action === "PROTECTED" ? "append-only" : "operational"}`);
  line();

  const status = await schemaStatus(client);
  const journal = readJournal().length;
  line(`migrations   : ${status.appliedCount} applied / ${journal} in the code${status.unrecorded.length ? `; not applied: ${status.unrecorded.join(", ")}` : ""}${status.missingTables.length ? `; missing tables: ${status.missingTables.join(", ")}` : ""}`);
  const seed = demoSeedBlockReason(config.DATABASE_URL, process.env);
  const c = certify(plan);
  const isProduction = identity.database === "easyfleet_production";

  verdict(!RENDER_HOST.test(identity.host), "host is not a Render database", "this tool opened only DATABASE_URL and the S3 bucket; no Render connection exists in this code path");
  verdict(identity.host.endsWith(".rds.amazonaws.com"), "host is an AWS RDS endpoint");
  verdict(status.ok && status.unrecorded.length === 0 && status.appliedCount === journal, "migrations are fully applied");
  verdict(c.pass, "database holds no operational or demo data", c.pass ? "" : c.failures.join("; "));
  if (isProduction) verdict(true, "administrators", plan.admins.length ? `${plan.admins.length} SUPER_ADMIN present` : "none yet (expected before the first-admin step)");
  verdict(plan.demo.users === 0 && plan.demo.vehicles === 0 && plan.demo.drivers === 0 && plan.demo.projects === 0 && plan.demo.maintenance === 0 && plan.demo.handovers === 0, "demo markers are all zero");
  verdict(isProduction ? seed !== null : true, "demo seed protection", isProduction ? `seed is blocked: ${seed ?? "NOT BLOCKED"}` : "not the production database (seed protection is only required there)");
  verdict(process.env.ALLOW_DEMO_SEED !== "true" && !process.env.DEMO_PASSWORD, "ALLOW_DEMO_SEED / DEMO_PASSWORD are not set in this environment");

  if (config.STORAGE_PROVIDER === "s3" && config.S3_BUCKET) {
    const s3 = new S3Client({ region: config.S3_REGION, ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}) });
    const b = await inspectBucket(s3, config.S3_BUCKET, config.S3_PREFIX ?? "");
    line();
    line(`bucket       : ${config.S3_BUCKET} (region ${config.S3_REGION ?? process.env.AWS_REGION ?? "?"}, prefix "${config.S3_PREFIX ?? ""}")`);
    verdict(b.reachable, "bucket is reachable (list only)", b.error ?? "");
    verdict(b.empty === true && plan.files.rows === 0, "bucket is empty and the files table is empty", b.reachable ? `${b.objectCount} object(s)${b.truncated ? "+" : ""}, ${plan.files.rows} file row(s)` : "");
  } else {
    line();
    verdict(false, "S3 bucket check", "STORAGE_PROVIDER is not s3 or S3_BUCKET is not set");
  }
  line();
  line(failed ? "OVERALL: FAIL" : "OVERALL: PASS");
} catch (e) {
  failed = true;
  console.error(`verify-aws-readonly failed: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://***") : "error"}`);
} finally {
  await client.query("rollback").catch(() => undefined);
  client.release();
  await pool.end();
  if (failed) process.exitCode = 2;
}
