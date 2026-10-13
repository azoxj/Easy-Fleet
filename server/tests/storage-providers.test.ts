import { randomUUID } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { files, organizations } from "../src/db/schema/index.js";
import { createStorageFromConfig, sendStoredFile, setStorageForTests, storeUpload } from "../src/services/storage.js";
import { LocalStorageProvider } from "../src/services/object-storage/local.js";
import { copyMissingObjects } from "../src/services/object-storage/migrate.js";
import { StorageNotFoundError } from "../src/services/object-storage/provider.js";
import { S3StorageProvider } from "../src/services/object-storage/s3.js";
import { app, createDriverUser, createProject, createUser, createVehicle, defaultOrgId, JPEG_BYTES, login } from "./helpers.js";

const key = () => `${randomUUID()}/${randomUUID()}`;
const dir = () => mkdtempSync(path.join(tmpdir(), "ef-store-"));
const drain = async (r: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

/** A fake S3: records every command and keeps objects in memory. */
function fakeS3(opts: { failHead?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; type?: string }>();
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const k = cmd.input.Key as string;
      if (name === "PutObjectCommand") {
        objects.set(k, { body: Buffer.from(cmd.input.Body as Buffer), type: cmd.input.ContentType as string });
        return {};
      }
      if (name === "GetObjectCommand") {
        const o = objects.get(k);
        if (!o) throw Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        return { Body: Readable.from([o.body]) };
      }
      if (name === "HeadObjectCommand") {
        const o = objects.get(k);
        if (!o) throw Object.assign(new Error("nope"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ContentLength: o.body.length };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(k);
        return {};
      }
      if (name === "HeadBucketCommand") {
        if (opts.failHead) throw new Error("denied");
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  return { client: client as never as S3Client, objects, calls };
}

afterEach(() => {
  setStorageForTests(null);
  vi.restoreAllMocks();
});

describe("local storage provider", () => {
  it("stores, reads, stats and removes; files are private (0600) and removal is idempotent", async () => {
    const root = dir();
    const p = new LocalStorageProvider(root);
    const k = key();
    await p.put(k, Buffer.from("hello"), "text/plain");
    expect((await p.stat(k))?.size).toBe(5);
    expect((await drain(await p.open(k))).toString()).toBe("hello");
    expect(statSync(path.join(root, k)).mode & 0o777).toBe(0o600);
    await p.remove(k);
    await p.remove(k);
    expect(await p.stat(k)).toBeNull();
    await expect(p.open(k)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("rejects every key that is not <uuid>/<uuid> before touching the disk (path traversal)", async () => {
    const p = new LocalStorageProvider(dir());
    for (const bad of ["../../etc/passwd", `${randomUUID()}/../../x`, "/etc/passwd", `${randomUUID()}/${randomUUID()}/extra`, "", `${randomUUID()}\\${randomUUID()}`, `${randomUUID()}/%2e%2e%2f`]) {
      await expect(p.put(bad, Buffer.from("x"), "x"), bad).rejects.toThrow("Invalid storage key");
      await expect(p.open(bad), bad).rejects.toThrow("Invalid storage key");
      await expect(p.stat(bad), bad).rejects.toThrow("Invalid storage key");
      await expect(p.remove(bad), bad).rejects.toThrow("Invalid storage key");
    }
  });

  it("health: writable with enough free space; not ready when the volume is (reported) too full", async () => {
    expect(await new LocalStorageProvider(dir(), 1).health()).toBe(true);
    expect(await new LocalStorageProvider(dir(), 1_000_000_000).health()).toBe(false); // more free space than any disk has
    const aFile = path.join(dir(), "plain-file");
    writeFileSync(aFile, "x");
    expect(await new LocalStorageProvider(path.join(aFile, "storage")).health()).toBe(false); // a directory cannot be created under a file
  });
});

describe("S3 storage provider (fake client — nothing leaves the machine)", () => {
  it("writes under the prefix with server-side encryption and the content type", async () => {
    const f = fakeS3();
    const p = new S3StorageProvider({ bucket: "b", prefix: "files", sse: "aws:kms", kmsKeyId: "arn:key", client: f.client });
    const k = key();
    await p.put(k, Buffer.from("abc"), "application/pdf");
    expect(f.calls[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "b", Key: `files/${k}`, ContentType: "application/pdf", ContentLength: 3, ServerSideEncryption: "aws:kms", SSEKMSKeyId: "arn:key" } });
    expect((await drain(await p.open(k))).toString()).toBe("abc");
    expect(await p.stat(k)).toEqual({ size: 3 });
    await p.remove(k);
    expect(await p.stat(k)).toBeNull();
    await expect(p.open(k)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("never sends a request for a key that is not <uuid>/<uuid>", async () => {
    const f = fakeS3();
    const p = new S3StorageProvider({ bucket: "b", client: f.client });
    for (const bad of ["../x", "a/b", "", `${randomUUID()}/../${randomUUID()}`, "//", `${randomUUID()}/${randomUUID()}/x`]) {
      await expect(p.open(bad)).rejects.toThrow("Invalid storage key");
      await expect(p.put(bad, Buffer.from("x"), "x")).rejects.toThrow();
      await expect(p.remove(bad)).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });

  it("readiness is a HeadBucket (no transfer), cached for 30 s, false when the bucket is unreachable", async () => {
    const ok = fakeS3();
    const p = new S3StorageProvider({ bucket: "b", client: ok.client });
    expect(await p.health()).toBe(true);
    expect(await p.health()).toBe(true);
    expect(ok.calls.map((c) => c.name)).toEqual(["HeadBucketCommand"]);
    const bad = new S3StorageProvider({ bucket: "b", client: fakeS3({ failHead: true }).client });
    expect(await bad.health()).toBe(false);
  });

  it("the configured provider is local unless STORAGE_PROVIDER=s3", () => {
    expect(createStorageFromConfig().name).toBe("local");
  });
});

describe("uploads and downloads through the API with S3 as the backend", () => {
  it("handover photo → stored in the (fake) bucket under <org>/<uuid> → downloaded by an authorized user only", async () => {
    const f = fakeS3();
    setStorageForTests(new S3StorageProvider({ bucket: "easy-fleet-test", prefix: "files/", client: f.client }));
    const pm = await createUser(["PROJECT_MANAGER"]);
    const project = await createProject({ managerId: pm.id });
    const vehicle = await createVehicle(project.id, { currentOdometer: 100 });
    const drv = await createDriverUser(project.id);
    const c = await login(pm.email);
    const session = (await c.post("/api/handovers", { vehicleId: vehicle.id, driverId: drv.driver.id })).body.data;
    const up = await request(app).put(`/api/public/handover/${session.token}/photos/FRONT`).set("Content-Type", "image/jpeg").send(JPEG_BYTES);
    expect(up.status).toBe(201);
    const put = f.calls.find((x) => x.name === "PutObjectCommand")!;
    expect(String(put.input.Key)).toMatch(new RegExp(`^files/${pm.orgId}/[0-9a-f-]{36}$`));
    expect(put.input.ContentType).toBe("image/jpeg");

    const detail = (await c.get(`/api/handovers/${session.id}`)).body.data;
    const photoId = detail.photos[0].id;
    const dl = await c.get(`/api/handover-photos/${photoId}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, JPEG_BYTES)).toBe(0);
    expect(dl.headers["content-security-policy"]).toContain("sandbox");
    expect(dl.headers["content-disposition"]).toContain("attachment");
    // another organization's administrator cannot reach it
    const [other] = await db.insert(organizations).values({ name: "منظمة أخرى", slug: `s3-${Date.now()}` }).returning();
    const stranger = await login((await createUser(["SUPER_ADMIN"], { orgId: other!.id })).email);
    expect((await stranger.get(`/api/handover-photos/${photoId}/file`)).status).toBe(404);
    // no credentials or storage details in anything the browser saw
    expect(JSON.stringify(detail)).not.toMatch(/easy-fleet-test|storageKey|AKIA/);
  });

  it("sendStoredFile refuses a file of another organization even if the caller forgot to authorize", async () => {
    const orgA = await defaultOrgId();
    const [orgB] = await db.insert(organizations).values({ name: "منظمة ب", slug: `b-${Date.now()}` }).returning();
    const k = `${orgA}/${randomUUID()}`;
    const [row] = await db.insert(files).values({ organizationId: orgA, storageKey: k, originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 3, sha256: "x" }).returning();
    const f = fakeS3();
    setStorageForTests(new S3StorageProvider({ bucket: "b", client: f.client }));
    await new S3StorageProvider({ bucket: "b", client: f.client }).put(k, Buffer.from("abc"), "application/pdf");
    const res = () => ({ setHeader: vi.fn(), on: vi.fn(), end: vi.fn(), destroy: vi.fn() }) as never;
    await expect(sendStoredFile(db, res(), row!.id, orgB!.id)).rejects.toMatchObject({ status: 404 });
    // a row whose key belongs to a different org than its owner is refused too
    const [bad] = await db.insert(files).values({ organizationId: orgB!.id, storageKey: `${orgA}/${randomUUID()}`, originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 3, sha256: "x" }).returning();
    await expect(sendStoredFile(db, res(), bad!.id, orgB!.id)).rejects.toMatchObject({ status: 404 });
    await db.delete(files).where(eq(files.id, bad!.id));
    await db.delete(files).where(eq(files.id, row!.id));
  });

  it("when the database row cannot be written the stored object is removed again", async () => {
    const f = fakeS3();
    setStorageForTests(new S3StorageProvider({ bucket: "b", client: f.client }));
    const failingDb = { insert: () => ({ values: () => ({ returning: () => Promise.reject(new Error("insert failed")) }) }) } as never;
    const req = { body: JPEG_BYTES, get: (h: string) => (h === "content-type" ? "image/jpeg" : undefined) } as never;
    await expect(storeUpload(failingDb, req, randomUUID(), null)).rejects.toThrow("insert failed");
    expect(f.calls.map((c) => c.name)).toEqual(["PutObjectCommand", "DeleteObjectCommand"]);
    expect(f.objects.size).toBe(0);
  });
});

describe("copying existing local files to S3 later (no business logic involved)", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ storageKey: key(), mimeType: "image/jpeg", sizeBytes: 10 + i }));

  it("dry run reports, apply copies, a second run finds nothing to do; nothing is ever deleted", async () => {
    const src = new LocalStorageProvider(dir());
    const dst = new LocalStorageProvider(dir());
    const list = rows(3);
    for (const r of list) await src.put(r.storageKey, Buffer.alloc(r.sizeBytes, 1), r.mimeType);

    const dry = await copyMissingObjects(src, dst, list, { apply: false });
    expect(dry).toMatchObject({ checked: 3, copied: 3, alreadyThere: 0 });
    expect(await dst.stat(list[0]!.storageKey)).toBeNull();

    const applied = await copyMissingObjects(src, dst, list, { apply: true });
    expect(applied).toMatchObject({ checked: 3, copied: 3, failed: [], missingInSource: [] });
    for (const r of list) expect((await dst.stat(r.storageKey))?.size).toBe(r.sizeBytes);

    const again = await copyMissingObjects(src, dst, list, { apply: true });
    expect(again).toMatchObject({ copied: 0, alreadyThere: 3 });
    for (const r of list) expect(await src.stat(r.storageKey)).not.toBeNull();
  });

  it("reports files missing from the source and size mismatches instead of guessing", async () => {
    const src = new LocalStorageProvider(dir());
    const dst = new LocalStorageProvider(dir());
    const [ok, missing, wrong] = rows(3) as [ReturnType<typeof rows>[number], ReturnType<typeof rows>[number], ReturnType<typeof rows>[number]];
    await src.put(ok.storageKey, Buffer.alloc(ok.sizeBytes), "x");
    await src.put(wrong.storageKey, Buffer.alloc(wrong.sizeBytes + 5), "x"); // row says one size, the file another
    const r = await copyMissingObjects(src, dst, [ok, missing, wrong], { apply: true });
    expect(r.copied).toBe(1);
    expect(r.missingInSource).toEqual([missing.storageKey]);
    expect(r.failed).toEqual([wrong.storageKey]);
    expect(await dst.stat(wrong.storageKey)).toBeNull();
  });
});
