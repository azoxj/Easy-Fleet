import { describe, expect, it } from "vitest";
import { inspectBucket } from "../src/services/aws-verify.js";

const fake = (r: unknown | Error) => ({ send: async () => { if (r instanceof Error) throw r; return r; } }) as never;

describe("inspectBucket (read-only)", () => {
  it("reports an empty bucket", async () => expect(await inspectBucket(fake({ KeyCount: 0 }), "b")).toMatchObject({ reachable: true, empty: true, objectCount: 0 }));
  it("reports objects", async () => expect(await inspectBucket(fake({ KeyCount: 3, IsTruncated: false }), "b")).toMatchObject({ empty: false, objectCount: 3 }));
  it("reports an unreachable bucket without leaking details", async () => {
    const r = await inspectBucket(fake(Object.assign(new Error("secret detail"), { name: "AccessDenied" })), "b");
    expect(r).toMatchObject({ reachable: false, empty: null, error: "AccessDenied" });
  });
});
