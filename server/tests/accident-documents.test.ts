import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { accidentAttachments, accidents, auditLogs } from "../src/db/schema/index.js";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { PDF_BYTES, PNG_BYTES, type Client } from "./helpers.js";
import { toTechnical, world, type W } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));

const CORE = ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"] as const;

const legacy = async (w: W) => (await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث بالمسار القديم", severity: "MINOR" })).body.data.id as string;
const put = (c: Client, id: string, category: string, bytes: Buffer = PDF_BYTES, mime = "application/pdf") => c.upload(`/api/accidents/${id}/attachments?category=${category}`, bytes, mime, "post");
const slots = async (c: Client, id: string) => (await c.get(`/api/accidents/${id}`)).body.data.documentSlots as { category: string; status: string; currentId: string | null; replacedCount: number }[];
const active = async (id: string, category: string) => db.select().from(accidentAttachments).where(and(eq(accidentAttachments.accidentId, id), eq(accidentAttachments.category, category)));

describe("legacy accident: the four core documents are independent, replaceable documents", () => {
  it("each document uploads on its own and has its own status", async () => {
    const w = await world();
    const id = await legacy(w);
    expect((await slots(w.c.pm, id)).map((s) => [s.category, s.status])).toEqual(CORE.map((c) => [c, "MISSING"]));
    for (const [i, category] of CORE.entries()) {
      const r = await put(w.c.pm, id, category);
      expect(r.status, `${category} ${JSON.stringify(r.body)}`).toBe(201);
      expect(r.body.data).toMatchObject({ category, replaced: false });
      const now = await slots(w.c.pm, id);
      expect(now.filter((s) => s.status === "UPLOADED")).toHaveLength(i + 1);
      expect(now.find((s) => s.category === category)).toMatchObject({ status: "UPLOADED", currentId: r.body.data.id, replacedCount: 0 });
    }
    const detail = (await w.c.pm.get(`/api/accidents/${id}`)).body.data;
    expect(detail.attachments[0]).toMatchObject({ fileName: expect.any(String), mimeType: "application/pdf", sizeBytes: PDF_BYTES.length, supersededAt: null, uploadedByName: expect.any(String) });
    expect((await put(w.c.pm, id, "NOT_A_DOCUMENT")).status).toBe(400);
  });

  it("replacing keeps the old file as history, the new one becomes current, and the old one is still downloadable", async () => {
    const w = await world();
    const id = await legacy(w);
    const first = (await put(w.c.pm, id, "DRIVER_LICENSE")).body.data.id as string;
    const second = await put(w.c.pm, id, "DRIVER_LICENSE", PNG_BYTES, "image/png");
    expect(second.status).toBe(201);
    expect(second.body.data.replaced).toBe(true);
    expect((await slots(w.c.pm, id)).find((s) => s.category === "DRIVER_LICENSE")).toMatchObject({ status: "UPLOADED", currentId: second.body.data.id, replacedCount: 1 });
    const rows = await active(id, "DRIVER_LICENSE");
    expect(rows.filter((r) => !r.supersededAt).map((r) => r.id)).toEqual([second.body.data.id]);
    expect(rows.find((r) => r.id === first)?.supersededAt).not.toBeNull();
    expect((await w.c.pm.get(`/api/accident-attachments/${first}/file`)).status).toBe(200);
    // the other three documents are untouched
    expect((await slots(w.c.pm, id)).filter((s) => s.status === "UPLOADED").map((s) => s.category)).toEqual(["DRIVER_LICENSE"]);
  });

  it("two people replacing the same document at once leave exactly one current file", async () => {
    const w = await world();
    const id = await legacy(w);
    await put(w.c.pm, id, "VEHICLE_REGISTRATION");
    const results = await Promise.all([put(w.c.pm, id, "VEHICLE_REGISTRATION"), put(w.c.pm, id, "VEHICLE_REGISTRATION"), put(w.c.manager, id, "VEHICLE_REGISTRATION")]);
    expect(results.map((r) => r.status).filter((s) => s === 201).length).toBeGreaterThanOrEqual(2);
    const rows = await active(id, "VEHICLE_REGISTRATION");
    expect(rows.filter((r) => !r.supersededAt)).toHaveLength(1);
    expect(rows.length).toBe(1 + results.filter((r) => r.status === 201).length);
  });

  it("the other categories still accumulate and are not replaced", async () => {
    const w = await world();
    const id = await legacy(w);
    await put(w.c.pm, id, "PHOTO", PNG_BYTES, "image/png");
    await put(w.c.pm, id, "PHOTO", PNG_BYTES, "image/png");
    expect((await active(id, "PHOTO")).filter((r) => !r.supersededAt)).toHaveLength(2);
  });

  it("permissions and the closed state still apply", async () => {
    const w = await world();
    const id = await legacy(w);
    expect((await put(w.c.viewer, id, "NAJM_REPORT")).status).toBe(403);
    expect([403, 404]).toContain((await put(w.c.otherPm, id, "NAJM_REPORT")).status);
    expect((await w.c.otherPm.get(`/api/accidents/${id}`)).status).not.toBe(200);
    expect(await active(id, "NAJM_REPORT")).toHaveLength(0);
    await put(w.c.pm, id, "NAJM_REPORT");
    await db.update(accidents).set({ status: "CLOSED" }).where(eq(accidents.id, id));
    const r = await put(w.c.pm, id, "NAJM_REPORT");
    expect(r.status).toBe(409);
    expect((await active(id, "NAJM_REPORT")).filter((x) => !x.supersededAt)).toHaveLength(1);
  });

  it("the audit trail records the upload without the file name of a personal document", async () => {
    const w = await world();
    const id = await legacy(w);
    const att = (await put(w.c.pm, id, "DRIVER_ID")).body.data.id as string;
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "accident"), eq(auditLogs.entityId, id), eq(auditLogs.action, "FILE_UPLOADED")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ category: "DRIVER_ID", attachmentId: att, replaced: false });
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(".pdf");
  });
});

describe("viewing a document in the browser", () => {
  it("?view=inline shows a PDF or an image in the browser; the default still downloads; both stay locked down", async () => {
    const w = await world();
    const id = await legacy(w);
    const pdf = (await put(w.c.pm, id, "NAJM_REPORT")).body.data.id as string;
    const png = (await put(w.c.pm, id, "PHOTO", PNG_BYTES, "image/png")).body.data.id as string;
    const dl = await w.c.pm.get(`/api/accident-attachments/${pdf}/file`);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    const inlinePdf = await w.c.pm.get(`/api/accident-attachments/${pdf}/file?view=inline`);
    expect(inlinePdf.status).toBe(200);
    expect(inlinePdf.headers["content-disposition"]).toBe("inline");
    expect(inlinePdf.headers["content-type"]).toContain("application/pdf");
    expect(inlinePdf.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(inlinePdf.headers["x-content-type-options"]).toBe("nosniff");
    const inlinePng = await w.c.pm.get(`/api/accident-attachments/${png}/file?view=inline`);
    expect(inlinePng.headers["content-disposition"]).toBe("inline");
    expect(inlinePng.headers["content-security-policy"]).toContain("sandbox");
    // somebody who cannot reach the accident gets nothing, inline or not
    expect([403, 404]).toContain((await w.c.otherPm.get(`/api/accident-attachments/${pdf}/file?view=inline`)).status);
  });
});

describe("workflow case: the same documents, same statuses", () => {
  it("the case detail carries the slots and the uploader; a document the caller may not see reads as not uploaded; inline view follows the same rule", async () => {
    const w = await world();
    const id = await toTechnical(w); // the four required documents were uploaded by the project manager
    const before = (await w.c.manager.get(`/api/accident-cases/${id}`)).body.data; // the manager sees the full case (the project manager only a summary once it has moved on)
    expect(before.documentSlots.map((s: { category: string; status: string }) => [s.category, s.status])).toEqual(CORE.map((c) => [c, "UPLOADED"]));
    expect(before.attachments.find((a: { category: string }) => a.category === "NAJM_REPORT")).toMatchObject({ uploadedByName: expect.any(String), sizeBytes: expect.any(Number) });
    // a read-only project member cannot see the personal documents, so for them those slots are not uploaded (nothing is revealed)
    const viewerSlots = (await w.c.viewer.get(`/api/accident-cases/${id}`)).body.data.documentSlots as { category: string; status: string }[];
    expect(viewerSlots.find((s) => s.category === "NAJM_REPORT")?.status).toBe("UPLOADED");
    expect(viewerSlots.find((s) => s.category === "DRIVER_ID")?.status).toBe("MISSING");
    // inline view works on the case route too and is audited
    const att = before.documentSlots.find((s: { category: string }) => s.category === "NAJM_REPORT").currentId as string;
    const view = await w.c.manager.get(`/api/accident-cases/${id}/attachments/${att}/file?view=inline`);
    expect(view.status).toBe(200);
    expect(view.headers["content-disposition"]).toBe("inline");
    expect((await w.c.viewer.get(`/api/accident-cases/${id}/attachments/${before.documentSlots.find((s: { category: string }) => s.category === "DRIVER_ID").currentId}/file?view=inline`)).status).toBe(404);
  });
});
