import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { accidentAttachments } from "../src/db/schema/index.js";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { PDF_BYTES } from "./helpers.js";
import { caseOf, newDraft, toFinalClosure, toTechnical, upload, world } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));

const snapshot = async (id: string) => {
  const c = await caseOf(id);
  const atts = await db.select({ id: accidentAttachments.id }).from(accidentAttachments).where(eq(accidentAttachments.accidentId, id));
  return JSON.stringify({ stage: c.workflowStage, status: c.status, description: c.description, updatedAt: c.updatedAt, atts: atts.map((a) => a.id).sort() });
};

describe("switching the workflow flag off after workflow cases exist", () => {
  it("legacy routes cannot edit, move or attach to workflow cases; workflow routes are hidden; data is intact when the flag returns", async () => {
    const w = await world();
    const draft = await newDraft(w);
    const tech = await toTechnical(w);
    const closing = await toTechnical(w);
    await toFinalClosure(w, closing);
    const ids = [draft, tech, closing];
    const before = await Promise.all(ids.map(snapshot));

    setAccidentWorkflowFlag(false);
    try {
      for (const id of ids) {
        for (const who of ["pm", "manager", "sa", "insurer", "tech"] as const) {
          const c = w.c[who];
          const patch = await c.patch(`/api/accidents/${id}`, { description: "تعديل عبر المسار القديم" });
          expect([404, 409, 403], `${who} PATCH ${patch.status}`).toContain(patch.status);
          const st = await c.post(`/api/accidents/${id}/status`, { to: "CLOSED" });
          expect([404, 409, 403], `${who} status ${st.status}`).toContain(st.status);
          const up = await c.agent.post(`/api/accidents/${id}/attachments?category=PHOTO`).set("X-CSRF-Token", c.csrf).set("Content-Type", "application/pdf").set("X-File-Name", "x.pdf").send(PDF_BYTES);
          expect([404, 409, 403], `${who} upload ${up.status}`).toContain(up.status);
          // the workflow surface is hidden while the flag is off
          expect((await c.get(`/api/accident-cases/${id}`)).status).toBe(404);
          expect((await c.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_ESTIMATES" })).status).toBe(404);
        }
      }
      expect((await w.c.pm.get("/api/accident-cases")).status).toBe(404);
      // an unprivileged reader never sees a private draft through the legacy detail either
      expect((await w.c.viewer.get(`/api/accidents/${draft}`)).status).toBe(404);
      expect((await w.c.finance.get(`/api/accidents/${draft}`)).status).toBe(404);
    } finally {
      setAccidentWorkflowFlag(true);
    }
    expect(await Promise.all(ids.map(snapshot))).toEqual(before);
    // access to the workflow is back, unchanged
    expect((await w.c.pm.get(`/api/accident-cases/${draft}`)).status).toBe(200);
    expect((await w.c.pm.patch(`/api/accident-cases/${draft}`, { description: "بعد إعادة التفعيل" })).status).toBe(200);
    await upload(w.c.pm, tech, "PHOTO");
  });
});
