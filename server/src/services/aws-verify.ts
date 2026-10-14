import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

export type BucketState = { reachable: boolean; empty: boolean | null; objectCount: number | null; truncated: boolean; error?: string };

/** Lists at most `limit` keys (read-only). "Empty" means no object under the configured prefix. */
export async function inspectBucket(client: Pick<S3Client, "send">, bucket: string, prefix = "", limit = 1000): Promise<BucketState> {
  try {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, MaxKeys: limit }));
    const n = r.KeyCount ?? r.Contents?.length ?? 0;
    return { reachable: true, empty: n === 0, objectCount: n, truncated: Boolean(r.IsTruncated) };
  } catch (e) {
    return { reachable: false, empty: null, objectCount: null, truncated: false, error: e instanceof Error ? e.name : "error" };
  }
}
