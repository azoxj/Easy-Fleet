import { StorageNotFoundError, type StorageProvider } from "./provider.js";

export type CopyResult = { checked: number; alreadyThere: number; copied: number; missingInSource: string[]; failed: string[] };

/**
 * Copies objects that are not yet in the target (same keys, so `files.storage_key` stays valid).
 * Never deletes anything in the source or the target. With apply=false it only reports what it would copy.
 */
export async function copyMissingObjects(
  source: StorageProvider,
  target: StorageProvider,
  files: AsyncIterable<{ storageKey: string; mimeType: string; sizeBytes: number }> | Iterable<{ storageKey: string; mimeType: string; sizeBytes: number }>,
  opts: { apply: boolean; log?: (m: string) => void },
): Promise<CopyResult> {
  const out: CopyResult = { checked: 0, alreadyThere: 0, copied: 0, missingInSource: [], failed: [] };
  for await (const f of files) {
    out.checked += 1;
    try {
      const there = await target.stat(f.storageKey);
      if (there && there.size === f.sizeBytes) {
        out.alreadyThere += 1;
        continue;
      }
      const src = await source.stat(f.storageKey);
      if (!src) {
        out.missingInSource.push(f.storageKey);
        continue;
      }
      if (!opts.apply) {
        out.copied += 1; // "would copy"
        continue;
      }
      const stream = await source.open(f.storageKey);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = Buffer.concat(chunks);
      if (body.length !== f.sizeBytes) throw new Error("size differs from the files table");
      await target.put(f.storageKey, body, f.mimeType);
      const verify = await target.stat(f.storageKey);
      if (!verify || verify.size !== body.length) throw new Error("verification failed");
      out.copied += 1;
      opts.log?.(`copied ${out.copied}`);
    } catch (e) {
      if (e instanceof StorageNotFoundError) out.missingInSource.push(f.storageKey);
      else out.failed.push(f.storageKey);
    }
  }
  return out;
}
