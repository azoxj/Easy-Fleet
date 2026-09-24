import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { config } from "../config.js";
import type { DbOrTx } from "../db/client.js";
import { files } from "../db/schema/index.js";
import { badRequest, HttpError } from "../http/errors.js";

/**
 * Private file storage on local disk (outside the web root).
 * Keys are generated server-side (<orgId>/<uuid>) so user input never becomes a path.
 * Swap this module for an object store (S3/GCS with signed URLs) later without touching routes.
 */
const ROOT = path.resolve(config.STORAGE_DIR);
export const MAX_UPLOAD_BYTES = config.MAX_UPLOAD_MB * 1024 * 1024;
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

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
export async function storeUpload(db: DbOrTx, req: Request, orgId: string, userId: string) {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("لم يتم إرسال ملف");
  if (body.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "حجم الملف أكبر من المسموح");
  const type = detectFileType(body);
  if (!type) throw badRequest("نوع الملف غير مسموح. المسموح: PDF, PNG, JPG, WEBP");
  const declared = (req.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const declaredOk = declared === type.mime || (type.mime === "image/jpeg" && declared === "image/jpg");
  if (!declaredOk) throw badRequest("نوع الملف لا يطابق محتواه");

  const key = `${orgId}/${randomUUID()}`;
  const full = path.join(ROOT, key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, body, { mode: 0o600, flag: "wx" });
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
}

export async function openStoredFile(storageKey: string) {
  if (!KEY_RE.test(storageKey)) throw new Error("Invalid storage key");
  const full = path.join(ROOT, storageKey);
  if (!full.startsWith(ROOT + path.sep)) throw new Error("Invalid storage path");
  await stat(full);
  return createReadStream(full);
}
