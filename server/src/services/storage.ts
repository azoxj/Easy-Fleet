import { createHash, randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import type { DbOrTx } from "../db/client.js";
import { files } from "../db/schema/index.js";
import { badRequest, HttpError, notFound } from "../http/errors.js";
import { tr } from "../i18n/index.js";
import { logger } from "../lib/logger.js";
import { LocalStorageProvider } from "./object-storage/local.js";
import { assertKey, StorageNotFoundError, type StorageProvider } from "./object-storage/provider.js";
import { S3StorageProvider } from "./object-storage/s3.js";

/**
 * Private file storage. The bytes live behind a StorageProvider (local disk or a private S3 bucket, chosen by
 * STORAGE_PROVIDER); keys are generated server-side (<orgId>/<uuid>) so user input never becomes a path, and
 * every download is authorized by the owning record before it reaches this module.
 */
export const MAX_UPLOAD_BYTES = config.MAX_UPLOAD_MB * 1024 * 1024;

let provider: StorageProvider | null = null;

export function createStorageFromConfig(): StorageProvider {
  if (config.STORAGE_PROVIDER === "s3") {
    return new S3StorageProvider({
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION,
      prefix: config.S3_PREFIX,
      endpoint: config.S3_ENDPOINT,
      sse: config.S3_SSE,
      kmsKeyId: config.S3_KMS_KEY_ID,
    });
  }
  return new LocalStorageProvider(config.STORAGE_DIR, config.STORAGE_MIN_FREE_MB);
}

export function getStorage(): StorageProvider {
  provider ??= createStorageFromConfig();
  return provider;
}

/** Tests only: swap the provider (null restores the configured one). */
export function setStorageForTests(p: StorageProvider | null) {
  provider = p;
}

/** Allowed types, identified by magic bytes — the client-declared Content-Type is never trusted alone. */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
export const ALLOWED_UPLOAD_MIME = SIGNATURES.map((s) => s.mime);

export function detectFileType(buf: Buffer) {
  return SIGNATURES.find((s) => s.test(buf)) ?? null;
}

function safeName(raw: string | undefined, ext: string): string {
  let name = "document";
  if (raw) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  // Strip any path, control and quote characters; keep it short.
  name = name.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f"<>:*?|]/g, "").trim().slice(0, 120) || "document";
  const base = name.replace(/\.[^.]*$/, "") || "document";
  return `${base}.${ext}`;
}

/** Validates the raw request body and stores it. Returns the new files row. */
export async function storeUpload(db: DbOrTx, req: Request, orgId: string, userId: string | null, opts: { imagesOnly?: boolean } = {}) {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest(tr("لم يتم إرسال ملف"));
  if (body.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", tr("حجم الملف أكبر من المسموح"));
  const type = detectFileType(body);
  if (!type) throw badRequest(tr("نوع الملف غير مسموح. المسموح: PDF, PNG, JPG, WEBP"));
  if (opts.imagesOnly && !type.mime.startsWith("image/")) throw badRequest(tr("يجب رفع صورة (PNG, JPG, WEBP)"));
  const declared = (req.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const declaredOk = declared === type.mime || (type.mime === "image/jpeg" && declared === "image/jpg");
  if (!declaredOk) throw badRequest(tr("نوع الملف لا يطابق محتواه"));

  const key = `${orgId}/${randomUUID()}`;
  const storage = getStorage();
  await storage.put(key, body, type.mime);
  try {
    const [row] = await db
      .insert(files)
      .values({
        organizationId: orgId,
        storageKey: key,
        originalName: safeName(req.get("x-file-name"), type.ext),
        mimeType: type.mime,
        sizeBytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        uploadedBy: userId,
      })
      .returning();
    return row!;
  } catch (e) {
    // The row could not be written: do not leave the object behind.
    await storage.remove(key).catch((err: unknown) => logger.warn("could not remove an object after a failed upload", { err }));
    throw e;
  }
}

export async function openStoredFile(storageKey: string) {
  assertKey(storageKey);
  return getStorage().open(storageKey);
}

/** Deletes the object and its `files` row. Only for files no record references (see the orphan cleanup job). */
export async function deleteStoredObject(storageKey: string) {
  assertKey(storageKey);
  await getStorage().remove(storageKey);
}

/**
 * Streams a stored file as a download. The file must belong to the caller's organization (checked here as a
 * second line of defence); callers MUST still authorize the owning record first.
 */
export async function sendStoredFile(db: DbOrTx, res: Response, fileId: string | null, orgId: string) {
  if (!fileId) throw notFound(tr("لا يوجد ملف مرفق"));
  const [f] = await db.select().from(files).where(and(eq(files.id, fileId), eq(files.organizationId, orgId)));
  if (!f || !f.storageKey.startsWith(`${orgId}/`)) throw notFound(tr("لا يوجد ملف مرفق"));
  const stream = await openStoredFile(f.storageKey).catch((e: unknown) => {
    if (!(e instanceof StorageNotFoundError)) logger.error("could not open a stored file", { err: e, fileId });
    throw notFound(tr("الملف غير متاح"));
  });
  res.setHeader("Content-Type", f.mimeType);
  res.setHeader("Content-Length", String(f.sizeBytes));
  res.setHeader("Content-Disposition", `attachment; filename="file.${f.originalName.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(f.originalName)}`);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, no-store");
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Free space on the volume used for temporary files and logs (on AWS the files themselves live in S3, the disk must still not fill up). */
async function scratchDiskOk(): Promise<boolean> {
  if (config.DISK_MIN_FREE_MB <= 0) return true;
  try {
    const s = await statfs(config.DISK_CHECK_PATH ?? tmpdir());
    return (s.bavail * s.bsize) / (1024 * 1024) >= config.DISK_MIN_FREE_MB;
  } catch {
    return false;
  }
}

/** Readiness of the configured provider (cheap; see each provider) and of the scratch disk. */
export const storageHealth = async () => (await getStorage().health()) && (await scratchDiskOk());
