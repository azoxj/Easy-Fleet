import { describe, expect, it } from "vitest";
import { decideAssignment } from "../src/modules/accidents/assignment.js";
import { missingForClaimStatus, missingForTransition, type CaseFacts } from "../src/modules/accidents/requirements.js";
import { canUploadAttachment, canViewAttachment, canViewSensitiveDocument, isSensitiveCategory, missingRequiredCategories, pickSuperseded, REQUIRED_FOR_SUBMIT, type SensitiveAccessInput } from "../src/modules/accidents/attachments-policy.js";
import { DEFAULT_SLA_DAYS, evaluateTransition, isOpenAccident, isOverdue, legacyStatusFor, requiredPermission, slaDueAt, WORKFLOW_STAGES, type WorkflowStage } from "../src/modules/accidents/workflow.js";
import { ROLES, type PermissionKey } from "../src/auth/permissions.js";

const ok = (from: WorkflowStage, to: WorkflowStage, extra: { returnedTo?: WorkflowStage | null; reason?: string } = {}) => evaluateTransition({ from, to, ...extra });

describe("accident workflow state machine", () => {
  it("walks the forward path stage by stage", () => {
    const path: WorkflowStage[] = ["DRAFT", "AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE", "CLOSED"];
    for (let i = 0; i < path.length - 1; i++) expect(ok(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`).toEqual({ ok: true, kind: "FORWARD" });
  });

  it("allows the documented shortcuts (no estimates needed, no compensation due) and nothing else forward", () => {
    expect(ok("AWAITING_TECHNICAL", "AWAITING_INSURANCE").ok).toBe(true);
    expect(ok("CLAIM_IN_PROGRESS", "AWAITING_FINAL_CLOSURE").ok).toBe(true);
    for (const [a, b] of [["DRAFT", "AWAITING_INSURANCE"], ["DRAFT", "CLOSED"], ["AWAITING_TECHNICAL", "CLOSED"], ["AWAITING_INSURANCE", "AWAITING_FINAL_CLOSURE"], ["CLAIM_IN_PROGRESS", "CLOSED"]] as const) {
      expect(ok(a, b).ok, `${a} → ${b}`).toBe(false);
    }
  });

  it("every transition not on the allowed list is refused (exhaustive)", () => {
    const allowed = new Set(["DRAFT>AWAITING_TECHNICAL", "AWAITING_TECHNICAL>AWAITING_ESTIMATES", "AWAITING_TECHNICAL>AWAITING_INSURANCE", "AWAITING_ESTIMATES>AWAITING_INSURANCE", "AWAITING_INSURANCE>CLAIM_IN_PROGRESS", "CLAIM_IN_PROGRESS>AWAITING_COMPENSATION_PROOF", "CLAIM_IN_PROGRESS>AWAITING_FINAL_CLOSURE", "AWAITING_COMPENSATION_PROOF>AWAITING_FINAL_CLOSURE", "AWAITING_FINAL_CLOSURE>CLOSED"]);
    for (const a of WORKFLOW_STAGES) for (const b of WORKFLOW_STAGES) {
      const r = ok(a, b, { reason: "سبب", returnedTo: "AWAITING_INSURANCE" });
      if (r.ok && r.kind === "FORWARD") expect(allowed.has(`${a}>${b}`), `${a} → ${b}`).toBe(true);
    }
    expect(ok("DRAFT", "DRAFT").ok).toBe(false);
  });

  it("returning to an earlier stage needs a reason; never into DRAFT/CLOSED, never to a later stage", () => {
    expect(ok("CLAIM_IN_PROGRESS", "AWAITING_TECHNICAL").ok).toBe(false);
    expect(ok("CLAIM_IN_PROGRESS", "AWAITING_TECHNICAL", { reason: "  " }).ok).toBe(false);
    expect(ok("CLAIM_IN_PROGRESS", "AWAITING_TECHNICAL", { reason: "نقص في التقدير" })).toEqual({ ok: true, kind: "RETURN" });
    expect(ok("AWAITING_FINAL_CLOSURE", "AWAITING_INSURANCE", { reason: "x" })).toEqual({ ok: true, kind: "RETURN" });
    expect(ok("AWAITING_TECHNICAL", "DRAFT", { reason: "x" }).ok).toBe(false);
    expect(ok("AWAITING_TECHNICAL", "RETURNED", { reason: "x" }).ok).toBe(false);
  });

  it("a returned case may only resume at the stage stored when it was returned", () => {
    expect(ok("RETURNED", "AWAITING_INSURANCE", { returnedTo: "AWAITING_INSURANCE" })).toEqual({ ok: true, kind: "RESUME" });
    expect(ok("RETURNED", "AWAITING_TECHNICAL", { returnedTo: "AWAITING_INSURANCE" }).ok).toBe(false);
    expect(ok("RETURNED", "AWAITING_TECHNICAL", { returnedTo: null }).ok).toBe(false);
    expect(ok("RETURNED", "CLOSED", { returnedTo: "AWAITING_INSURANCE" }).ok).toBe(false);
  });

  it("a closed case reopens only with a reason", () => {
    expect(ok("CLOSED", "AWAITING_FINAL_CLOSURE").ok).toBe(false);
    expect(ok("CLOSED", "AWAITING_FINAL_CLOSURE", { reason: "ظهرت مستندات جديدة" })).toEqual({ ok: true, kind: "REOPEN" });
    expect(ok("CLOSED", "DRAFT", { reason: "x" }).ok).toBe(false);
  });

  it("required permission per move: forward by stage owner, return/reopen by accidents.reopen, resume by accidents.assign", () => {
    expect(requiredPermission("DRAFT", "FORWARD")).toBe("accidents.update"); // a driver files the draft, the project manager submits it
    expect(requiredPermission("AWAITING_ESTIMATES", "FORWARD")).toBe("accidents.update");
    expect(requiredPermission("AWAITING_TECHNICAL", "FORWARD")).toBe("accidents.review.technical");
    expect(requiredPermission("CLAIM_IN_PROGRESS", "FORWARD")).toBe("accidents.claims.manage");
    expect(requiredPermission("AWAITING_FINAL_CLOSURE", "FORWARD")).toBe("accidents.close");
    expect(requiredPermission("CLAIM_IN_PROGRESS", "RETURN")).toBe("accidents.reopen");
    expect(requiredPermission("CLOSED", "REOPEN")).toBe("accidents.reopen");
    expect(requiredPermission("RETURNED", "RESUME")).toBe("accidents.assign");
  });

  it("maps every stage to a legacy status; only CLOSED closes; drafts are not open accidents", () => {
    expect(WORKFLOW_STAGES.map(legacyStatusFor)).toEqual(["OPEN", "UNDER_REVIEW", "UNDER_REVIEW", "INSURANCE", "INSURANCE", "INSURANCE", "UNDER_REVIEW", "CLOSED", "UNDER_REVIEW"]);
    expect(isOpenAccident({ status: "OPEN", workflowStage: "DRAFT" })).toBe(false);
    expect(isOpenAccident({ status: "OPEN", workflowStage: null })).toBe(true);
    expect(isOpenAccident({ status: "UNDER_REVIEW", workflowStage: "AWAITING_TECHNICAL" })).toBe(true);
    expect(isOpenAccident({ status: "CLOSED", workflowStage: "CLOSED" })).toBe(false);
  });

  it("SLA defaults are calendar days: technical 3, estimates 5, insurance 7, closure 3, adjustable per call", () => {
    expect(DEFAULT_SLA_DAYS).toEqual({ slaTechnicalDays: 3, slaEstimatesDays: 5, slaInsuranceDays: 7, slaClosureDays: 3 });
    const t0 = new Date("2026-01-01T00:00:00Z"); // a Thursday: calendar days still count Friday/Saturday
    expect(slaDueAt("AWAITING_TECHNICAL", t0)!.toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(slaDueAt("AWAITING_ESTIMATES", t0)!.toISOString()).toBe("2026-01-06T00:00:00.000Z");
    expect(slaDueAt("CLAIM_IN_PROGRESS", t0)!.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(slaDueAt("AWAITING_FINAL_CLOSURE", t0)!.toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(slaDueAt("DRAFT", t0)).toBeNull();
    expect(slaDueAt("CLOSED", t0)).toBeNull();
    expect(slaDueAt("AWAITING_TECHNICAL", t0, { ...DEFAULT_SLA_DAYS, slaTechnicalDays: 1 })!.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(isOverdue("AWAITING_TECHNICAL", t0, new Date("2026-01-04T00:00:01Z"))).toBe(true);
    expect(isOverdue("AWAITING_TECHNICAL", t0, new Date("2026-01-03T23:59:59Z"))).toBe(false);
  });
});

describe("accident assignment engine", () => {
  const P = "project-1";
  const cand = (userId: string, projectId: string | null, extra: Partial<{ active: boolean; holdsPermission: boolean }> = {}) => ({ userId, projectId, active: true, holdsPermission: true, ...extra });

  it("exactly one project officer is assigned automatically", () => {
    expect(decideAssignment([cand("u1", P)], P)).toEqual({ mode: "AUTO", userId: "u1", level: "PROJECT" });
  });
  it("a project officer wins over the organisation officer", () => {
    expect(decideAssignment([cand("org", null), cand("u1", P)], P)).toMatchObject({ mode: "AUTO", userId: "u1" });
  });
  it("falls back to a single organisation-wide officer", () => {
    expect(decideAssignment([cand("org", null), cand("other", "project-2")], P)).toEqual({ mode: "AUTO", userId: "org", level: "ORGANIZATION" });
    expect(decideAssignment([cand("org", null)], null)).toMatchObject({ mode: "AUTO", userId: "org" });
  });
  it("no officer or several officers go to the queue, never a random pick", () => {
    expect(decideAssignment([], P)).toEqual({ mode: "QUEUE", reason: "NO_OFFICER" });
    expect(decideAssignment([cand("a", P), cand("b", P)], P)).toEqual({ mode: "QUEUE", reason: "MULTIPLE_OFFICERS" });
    expect(decideAssignment([cand("a", null), cand("b", null)], P)).toEqual({ mode: "QUEUE", reason: "MULTIPLE_OFFICERS" });
    expect(decideAssignment([cand("a", "project-2")], P)).toEqual({ mode: "QUEUE", reason: "NO_OFFICER" });
  });
  it("an inactive officer, or one who lost the stage permission, is not eligible", () => {
    expect(decideAssignment([cand("a", P, { active: false })], P)).toMatchObject({ mode: "QUEUE" });
    expect(decideAssignment([cand("a", P, { holdsPermission: false }), cand("org", null)], P)).toMatchObject({ mode: "AUTO", userId: "org" });
  });
  it("the same user listed twice at one level counts once", () => {
    expect(decideAssignment([cand("a", P), cand("a", P)], P)).toMatchObject({ mode: "AUTO", userId: "a" });
  });
});

describe("accident attachments policy", () => {
  it("submission needs the Najm report, driver ID, licence and vehicle registration", () => {
    expect(REQUIRED_FOR_SUBMIT).toEqual(["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"]);
    expect(missingRequiredCategories([])).toEqual([...REQUIRED_FOR_SUBMIT]);
    expect(missingRequiredCategories(["NAJM_REPORT", "DRIVER_ID", "PHOTO"])).toEqual(["DRIVER_LICENSE", "VEHICLE_REGISTRATION"]);
    expect(missingRequiredCategories([...REQUIRED_FOR_SUBMIT, "PHOTO"])).toEqual([]);
  });

  it("photos, invoices and the Najm report stay non-sensitive; personal, financial, police and insurance documents are sensitive", () => {
    for (const c of ["PHOTO", "REPAIR_INVOICE", "OTHER", "NAJM_REPORT", "ESTIMATE"]) expect(isSensitiveCategory(c), c).toBe(false);
    for (const c of ["POLICE_REPORT", "INSURANCE", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION", "CLAIM_FORM", "INSURER_DECISION", "COMPENSATION_PROOF"]) expect(isSensitiveCategory(c), c).toBe(true);
  });

  const base: SensitiveAccessInput = {
    userId: "me",
    scope: "PROJECT",
    inScope: true,
    accident: { createdBy: "creator", reportedBy: null, assignedTo: "assignee" },
    previousHandlers: ["earlier"],
    isManager: false,
  };

  it("sensitive documents: permission alone is not enough — a non-participant technician is refused", () => {
    expect(canViewSensitiveDocument(base)).toBe(false);
    expect(canViewAttachment("DRIVER_ID", base)).toBe(false);
    expect(canViewAttachment("POLICE_REPORT", base)).toBe(false);
    expect(canViewAttachment("INSURANCE", base)).toBe(false);
    expect(canViewAttachment("PHOTO", base)).toBe(true);
  });
  it("without the permission or outside the scope nobody sees them, not even a participant or manager", () => {
    expect(canViewSensitiveDocument({ ...base, scope: undefined, accident: { ...base.accident, assignedTo: "me" } })).toBe(false);
    expect(canViewSensitiveDocument({ ...base, inScope: false, isManager: true })).toBe(false);
  });
  it("creator, reporter, current or previous assignee and managers see them", () => {
    expect(canViewSensitiveDocument({ ...base, accident: { ...base.accident, createdBy: "me" } })).toBe(true);
    expect(canViewSensitiveDocument({ ...base, accident: { ...base.accident, reportedBy: "me" } })).toBe(true);
    expect(canViewSensitiveDocument({ ...base, accident: { ...base.accident, assignedTo: "me" } })).toBe(true);
    expect(canViewSensitiveDocument({ ...base, previousHandlers: ["me"] })).toBe(true);
    expect(canViewSensitiveDocument({ ...base, isManager: true })).toBe(true);
  });

  it("FINANCE, DRIVER, USER and VIEWER hold no sensitive-document permission", () => {
    for (const r of ["FINANCE", "DRIVER", "USER", "VIEWER"] as const) expect((ROLES[r].grants as Partial<Record<PermissionKey, string>>)["accidents.documents.sensitive"], r).toBeUndefined();
    expect(ROLES.TECHNICAL.grants["accidents.documents.sensitive"]).toBe("PROJECT");
    expect(ROLES.INSURANCE_OFFICER.grants["accidents.documents.sensitive"]).toBe("ALL");
  });

  it("re-uploading supersedes the current file of that category and never touches others", () => {
    const rows = [
      { id: "1", category: "DRIVER_ID", supersededAt: null },
      { id: "2", category: "DRIVER_ID", supersededAt: new Date() },
      { id: "3", category: "NAJM_REPORT", supersededAt: null },
    ];
    expect(pickSuperseded(rows, "DRIVER_ID").map((r) => r.id)).toEqual(["1"]);
    expect(pickSuperseded(rows, "ESTIMATE")).toEqual([]);
  });
});


const facts = (over: Partial<CaseFacts> = {}): CaseFacts => ({ attachmentCategories: [], damageDescription: null, technicalNotes: null, repairDecision: null, estimates: [], claim: null, resolution: null, ...over });
const claim = (over: Partial<NonNullable<CaseFacts["claim"]>> = {}): NonNullable<CaseFacts["claim"]> => ({ status: "FILED", insurerName: "ش", claimNumber: "1", filedAt: new Date(), rejectionReason: null, receivedAmount: null, ...over });

describe("stage requirements", () => {
  it("submission needs the four documents; superseded or other files do not count", () => {
    expect(missingForTransition("DRAFT", "AWAITING_TECHNICAL", facts())).toHaveLength(4);
    expect(missingForTransition("DRAFT", "AWAITING_TECHNICAL", facts({ attachmentCategories: [...REQUIRED_FOR_SUBMIT, "PHOTO"] }))).toEqual([]);
    expect(missingForTransition("DRAFT", "AWAITING_TECHNICAL", facts({ attachmentCategories: ["PHOTO", "OTHER", "POLICE_REPORT", "ESTIMATE"] }))).toHaveLength(4);
  });
  it("technical review: damage + the repair decision decide the way on; skipping the estimates needs an explained decision", () => {
    const T = "AWAITING_TECHNICAL";
    expect(missingForTransition(T, "AWAITING_ESTIMATES", facts({ damageDescription: "ضرر", repairDecision: "REPAIR" }))).toEqual([]);
    expect(missingForTransition(T, "AWAITING_ESTIMATES", facts({ damageDescription: "ضرر", repairDecision: "NOT_REPAIRABLE" }))).toEqual(["technical.repair"]);
    expect(missingForTransition(T, "AWAITING_ESTIMATES", facts({ damageDescription: "ضرر", repairDecision: "NOT_NEEDED" }))).toEqual(["technical.repair"]);
    expect(missingForTransition(T, "AWAITING_ESTIMATES", facts({ damageDescription: "ضرر" }))).toEqual(["technical.repairDecision"]);
    expect(missingForTransition(T, "AWAITING_ESTIMATES", facts({ damageDescription: "  ", repairDecision: "REPAIR" }))).toEqual(["technical.damageDescription"]);
    for (const d of ["NOT_REPAIRABLE", "NOT_NEEDED"] as const) {
      expect(missingForTransition(T, "AWAITING_INSURANCE", facts({ damageDescription: "ضرر", technicalNotes: "السبب", repairDecision: d }))).toEqual([]);
      expect(missingForTransition(T, "AWAITING_INSURANCE", facts({ damageDescription: "ضرر", repairDecision: d }))).toEqual(["technical.notes"]);
    }
    expect(missingForTransition(T, "AWAITING_INSURANCE", facts({ damageDescription: "ضرر", technicalNotes: "x", repairDecision: "REPAIR" }))).toEqual(["technical.no_repair_decision"]);
    expect(missingForTransition(T, "AWAITING_INSURANCE", facts({ damageDescription: "ضرر", technicalNotes: "x" }))).toEqual(["technical.no_repair_decision"]);
  });
  it("estimates: at least one and exactly one chosen", () => {
    expect(missingForTransition("AWAITING_ESTIMATES", "AWAITING_INSURANCE", facts())).toEqual(["estimates.none", "estimates.selected"]);
    expect(missingForTransition("AWAITING_ESTIMATES", "AWAITING_INSURANCE", facts({ estimates: [{ selected: false }] }))).toEqual(["estimates.selected"]);
    expect(missingForTransition("AWAITING_ESTIMATES", "AWAITING_INSURANCE", facts({ estimates: [{ selected: true }, { selected: false }] }))).toEqual([]);
    expect(missingForTransition("AWAITING_ESTIMATES", "AWAITING_INSURANCE", facts({ estimates: [{ selected: true }, { selected: true }] }))).toEqual(["estimates.selected"]);
  });
  it("claim stages need the claim details, the decision and the documents", () => {
    expect(missingForTransition("AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", facts())).toEqual(["claim.missing"]);
    expect(missingForTransition("AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", facts({ claim: claim({ claimNumber: " " }) }))).toEqual(["claim.details"]);
    expect(missingForTransition("AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", facts({ claim: claim() }))).toEqual([]);
    expect(missingForTransition("CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", facts({ claim: claim({ status: "PROCESSING" }) }))).toEqual(["claim.approved"]);
    expect(missingForTransition("CLAIM_IN_PROGRESS", "AWAITING_FINAL_CLOSURE", facts({ claim: claim({ status: "REJECTED", rejectionReason: "غير مشمول" }), attachmentCategories: ["INSURER_DECISION"] }))).toEqual([]);
    expect(missingForTransition("CLAIM_IN_PROGRESS", "AWAITING_FINAL_CLOSURE", facts({ claim: claim({ status: "APPROVED" }) }))).toEqual(["claim.rejected", "claim.rejectionReason", "attachment:INSURER_DECISION"]);
    expect(missingForTransition("AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE", facts({ claim: claim({ status: "COMPENSATION_RECEIVED", receivedAmount: "10" }), attachmentCategories: ["COMPENSATION_PROOF"] }))).toEqual([]);
    expect(missingForTransition("AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE", facts({ claim: claim({ status: "APPROVED" }) }))).toEqual(["claim.compensation_received", "claim.receivedAmount", "attachment:COMPENSATION_PROOF"]);
  });
  it("closure needs a resolution, a finished claim AND the repair documented or the decision not to repair explained", () => {
    const done = { resolution: "تم", claim: claim({ status: "REJECTED" }) };
    expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts())).toEqual(["resolution", "claim.terminal", "repair.decision"]);
    // a finished claim alone is not enough
    expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts(done))).toEqual(["repair.decision"]);
    expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts({ ...done, repairDecision: "REPAIR" }))).toEqual(["repair.documentation"]);
    expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts({ ...done, repairDecision: "REPAIR", attachmentCategories: ["PHOTO", "ESTIMATE"] }))).toEqual(["repair.documentation"]);
    for (const doc of ["REPAIR_INVOICE", "REPAIR_COMPLETION"]) expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts({ ...done, repairDecision: "REPAIR", attachmentCategories: [doc] }))).toEqual([]);
    for (const d of ["NOT_REPAIRABLE", "NOT_NEEDED"] as const) {
      expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts({ ...done, repairDecision: d }))).toEqual(["technical.notes"]);
      expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts({ ...done, repairDecision: d, damageDescription: "ضرر", technicalNotes: "لا حاجة للإصلاح لأن الضرر تجميلي" }))).toEqual([]);
    }
    expect(missingForTransition("AWAITING_FINAL_CLOSURE", "CLOSED", facts({ ...done, claim: claim({ status: "APPROVED" }), repairDecision: "REPAIR", attachmentCategories: ["REPAIR_INVOICE"] }))).toEqual(["claim.terminal"]);
    expect(missingForTransition("CLOSED", "AWAITING_FINAL_CLOSURE", facts())).toEqual([]);
    expect(missingForTransition("CLAIM_IN_PROGRESS", "AWAITING_TECHNICAL", facts())).toEqual([]);
  });
  it("claim status changes: rejection needs reason + decision, compensation needs amount + proof", () => {
    expect(missingForClaimStatus("REJECTED", {}, facts())).toEqual(["claim.rejectionReason", "attachment:INSURER_DECISION"]);
    expect(missingForClaimStatus("REJECTED", { reason: "x" }, facts({ attachmentCategories: ["INSURER_DECISION"] }))).toEqual([]);
    expect(missingForClaimStatus("COMPENSATION_RECEIVED", {}, facts())).toEqual(["claim.receivedAmount", "attachment:COMPENSATION_PROOF"]);
    expect(missingForClaimStatus("APPROVED", {}, facts())).toEqual([]);
  });
});

describe("who may upload what", () => {
  const base = { stage: "DRAFT", isCreator: false, handlesProject: false, isTechnicalActor: false, isClaimsActor: false };
  it("claim documents only for the claims officer in the insurance stages; estimates only for the project manager in their stage", () => {
    for (const category of ["CLAIM_FORM", "INSURER_DECISION", "COMPENSATION_PROOF"]) {
      expect(canUploadAttachment({ ...base, category, stage: "CLAIM_IN_PROGRESS", isClaimsActor: true })).toBe(true);
      expect(canUploadAttachment({ ...base, category, stage: "AWAITING_TECHNICAL", isClaimsActor: true })).toBe(false);
      expect(canUploadAttachment({ ...base, category, stage: "CLAIM_IN_PROGRESS", handlesProject: true, isCreator: true })).toBe(false);
    }
    expect(canUploadAttachment({ ...base, category: "ESTIMATE", stage: "AWAITING_ESTIMATES", handlesProject: true })).toBe(true);
    expect(canUploadAttachment({ ...base, category: "ESTIMATE", stage: "AWAITING_TECHNICAL", handlesProject: true })).toBe(false);
    expect(canUploadAttachment({ ...base, category: "ESTIMATE", stage: "AWAITING_ESTIMATES", isTechnicalActor: true })).toBe(false);
  });
  it("a draft takes files from its creator and the handler; later only the handler (and the technician's photos); nothing when closed", () => {
    expect(canUploadAttachment({ ...base, category: "DRIVER_ID", isCreator: true })).toBe(true);
    expect(canUploadAttachment({ ...base, category: "DRIVER_ID" })).toBe(false);
    expect(canUploadAttachment({ ...base, category: "DRIVER_ID", stage: "AWAITING_TECHNICAL", isCreator: true })).toBe(false);
    expect(canUploadAttachment({ ...base, category: "DRIVER_ID", stage: "AWAITING_TECHNICAL", handlesProject: true })).toBe(true);
    expect(canUploadAttachment({ ...base, category: "PHOTO", stage: "AWAITING_TECHNICAL", isTechnicalActor: true })).toBe(true);
    expect(canUploadAttachment({ ...base, category: "DRIVER_ID", stage: "AWAITING_TECHNICAL", isTechnicalActor: true })).toBe(false);
    expect(canUploadAttachment({ ...base, category: "PHOTO", stage: "CLOSED", handlesProject: true, isCreator: true })).toBe(false);
  });
  it("the uploader sees their own sensitive file; the case handler keeps legacy police and insurance files", () => {
    const input = { userId: "me", scope: undefined, inScope: false, accident: { createdBy: "x", reportedBy: null, assignedTo: null }, previousHandlers: [], isManager: false };
    expect(canViewAttachment("DRIVER_ID", input, "me")).toBe(true);
    expect(canViewAttachment("DRIVER_ID", input, "someone")).toBe(false);
    expect(canViewAttachment("DRIVER_ID", input, null)).toBe(false);
    expect(canViewAttachment("POLICE_REPORT", { ...input, handlesProject: true, inScope: false }, "x")).toBe(true);
    expect(canViewAttachment("DRIVER_ID", { ...input, handlesProject: true, inScope: false }, "x")).toBe(false); // new categories need the permission
    expect(canViewAttachment("DRIVER_ID", { ...input, handlesProject: true, inScope: true, scope: "PROJECT" }, "x")).toBe(true);
  });
});
