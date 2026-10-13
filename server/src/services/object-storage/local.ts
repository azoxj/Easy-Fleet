import { constants, createReadStream } from "node:fs";
import { access, mkdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { assertKey, StorageNotFoundError, type StorageProvider } from "./provider.js";

/** Private files on a local directory outside the web root (dev, Render disk, single server). */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local" as const;
  private readonly root: string;

  constructor(
    root: string,
    private readonly minFreeMb = 0,
  ) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertKey(key);
    const full = path.join(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Invalid storage path");
    return full;
  }

  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, body, { mode: 0o600, flag: "wx" });
  }

  async open(key: string): Promise<Readable> {
    const full = this.resolve(key);
    try {
      await stat(full);
    } catch {
      throw new StorageNotFoundError();
    }
    return createReadStream(full);
  }

  async stat(key: string) {
    try {
      return { size: (await stat(this.resolve(key))).size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** Directory writable AND enough free space (a full disk used to look "ready"). */
  async health(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await access(this.root, constants.W_OK);
      if (this.minFreeMb > 0) {
        const s = await statfs(this.root);
        if ((s.bavail * s.bsize) / (1024 * 1024) < this.minFreeMb) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
