import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertKey, StorageNotFoundError, type StorageProvider } from "./provider.js";

export type S3Options = {
  bucket: string;
  region?: string;
  /** Key prefix inside the bucket ("prod/"); normalised to end with "/". */
  prefix?: string;
  /** S3-compatible stores only (MinIO, LocalStack). Leave unset on AWS. */
  endpoint?: string;
  sse?: "AES256" | "aws:kms";
  kmsKeyId?: string;
  /** Injected in tests. */
  client?: Pick<S3Client, "send">;
};

const isMissing = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === "NoSuchKey" || x?.name === "NotFound" || x?.$metadata?.httpStatusCode === 404;
};

/**
 * Private S3 bucket. Credentials come from the AWS default chain (the EC2 instance role) — nothing secret is
 * configured here and nothing ever reaches the browser: downloads are streamed by the server after the
 * application has authorized the record, so the bucket stays fully private (Block Public Access).
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = "s3" as const;
  private readonly client: Pick<S3Client, "send">;
  private readonly bucket: string;
  private readonly prefix: string;
  private healthy: { at: number; ok: boolean } | null = null;

  constructor(private readonly opts: S3Options) {
    this.bucket = opts.bucket;
    const p = (opts.prefix ?? "").trim().replace(/^\/+/, "");
    this.prefix = p && !p.endsWith("/") ? `${p}/` : p;
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region,
        ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
        maxAttempts: 3,
      });
  }

  private full(key: string): string {
    assertKey(key);
    return `${this.prefix}${key}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
        ...(this.opts.sse ? { ServerSideEncryption: this.opts.sse } : {}),
        ...(this.opts.sse === "aws:kms" && this.opts.kmsKeyId ? { SSEKMSKeyId: this.opts.kmsKeyId } : {}),
      }),
    );
  }

  async open(key: string): Promise<Readable> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      if (!r.Body) throw new StorageNotFoundError();
      return r.Body as Readable;
    } catch (e) {
      if (isMissing(e)) throw new StorageNotFoundError();
      throw e;
    }
  }

  async stat(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      return { size: r.ContentLength ?? 0 };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
  }

  /** HeadBucket (no object transferred), cached for 30 s so /readyz stays cheap. */
  async health(): Promise<boolean> {
    const now = Date.now();
    if (this.healthy && now - this.healthy.at < 30_000) return this.healthy.ok;
    let ok = false;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: AbortSignal.timeout(3000) });
      ok = true;
    } catch {
      ok = false;
    }
    this.healthy = { at: now, ok };
    return ok;
  }
}
