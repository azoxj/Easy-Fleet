import "./_script-env.js";
import { gt } from "drizzle-orm";
import { config } from "../config.js";
import { db, pool } from "../db/client.js";
import { files } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { createStorageFromConfig } from "../services/storage.js";
import { LocalStorageProvider } from "../services/object-storage/local.js";
import { copyMissingObjects } from "../services/object-storage/migrate.js";

/**
 * One-off copy of uploaded files from a local directory to the configured S3 bucket (same keys, so no row in
 * `files` changes and no business logic is touched). Safe to run repeatedly: objects already in S3 with the right
 * size are skipped. It never deletes anything, locally or in S3. Dry run unless --apply is given.
 *
 *   STORAGE_PROVIDER=s3 S3_BUCKET=… S3_REGION=… STORAGE_SOURCE_DIR=/var/data/files \
 *     node dist/scripts/migrate-storage-to-s3.js            # report only
 *     node dist/scripts/migrate-storage-to-s3.js --apply    # copy
 */
const apply = process.argv.includes("--apply");
const sourceDir = process.env.STORAGE_SOURCE_DIR?.trim();
if (config.STORAGE_PROVIDER !== "s3") {
  console.error("[storage] set STORAGE_PROVIDER=s3 (the target) before running this script");
  process.exit(1);
}
if (!sourceDir) {
  console.error("[storage] set STORAGE_SOURCE_DIR to the local directory that holds the current files");
  process.exit(1);
}

async function* allFiles() {
  let last = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const batch = await db
      .select({ id: files.id, storageKey: files.storageKey, mimeType: files.mimeType, sizeBytes: files.sizeBytes })
      .from(files)
      .where(gt(files.id, last))
      .orderBy(files.id)
      .limit(500);
    if (!batch.length) return;
    for (const f of batch) yield f;
    last = batch[batch.length - 1]!.id;
  }
}

try {
  const source = new LocalStorageProvider(sourceDir);
  const target = createStorageFromConfig();
  logger.info(apply ? "copying files to S3" : "dry run: nothing will be copied (use --apply)");
  const r = await copyMissingObjects(source, target, allFiles(), { apply });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", checked: r.checked, alreadyInS3: r.alreadyThere, [apply ? "copied" : "wouldCopy"]: r.copied, missingInSource: r.missingInSource.length, failed: r.failed.length, sampleMissing: r.missingInSource.slice(0, 20), sampleFailed: r.failed.slice(0, 20) }, null, 2));
  if (r.failed.length || (apply && r.missingInSource.length)) process.exitCode = 2;
} finally {
  await pool.end();
}
