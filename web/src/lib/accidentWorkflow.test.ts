import { afterEach, describe, expect, it } from "vitest";
import { ar } from "../i18n/ar";
import { en } from "../i18n/en";
import { setLocale } from "../i18n";
import {
  accidentTabs,
  CLAIM_STATUSES,
  claimStatusLabel,
  DOC_CATEGORIES,
  docLabel,
  draftBody,
  isTabKey,
  missingDocuments,
  missingFor,
  missingFromError,
  nextActionLabel,
  pendingMissing,
  REPAIR_DECISIONS,
  repairDecisionLabel,
  REQUIRED_DOCS,
  REQUIREMENT_CODES,
  requiredActorText,
  requirementText,
  returnTargetsFrom,
  STAGES,
  stageLabel,
  type CaseDetail,
} from "./accidentWorkflow";

afterEach(() => setLocale("ar"));

const has = (perms: string[]) => (p: string) => perms.includes(p);
const ROLES: Record<string, string[]> = {
  PROJECT_MANAGER: ["accidents.read", "accidents.create", "accidents.update", "accidents.documents.sensitive"],
  TECHNICAL: ["accidents.read", "accidents.review.technical", "accidents.documents.sensitive"],
  INSURANCE_OFFICER: ["accidents.read", "accidents.claims.manage", "accidents.documents.sensitive"],
  ACCIDENT_MANAGER: ["accidents.read", "accidents.assign", "accidents.close", "accidents.reopen", "accidents.documents.sensitive"],
  FINANCE: ["accidents.read"],
  DRIVER: ["accidents.read", "accidents.create"],
  VIEWER: ["accidents.read"],
  USER: ["accidents.read"],
};
const keys = (perms: string[], workflow = true) => accidentTabs(has(perms), workflow).map((x) => x.key);

describe("accident tabs by permission", () => {
  it("without the workflow only the existing list is shown, whoever the user is", () => {
    for (const [role, perms] of Object.entries(ROLES)) expect(keys(perms, false), role).toEqual(["all"]);
  });

  it("each role gets exactly the tabs that have something for it", () => {
    expect(keys(ROLES.PROJECT_MANAGER!)).toEqual(["all", "reported", "returned", "drafts", "claims"]);
    expect(keys(ROLES.TECHNICAL!)).toEqual(["all", "assigned", "returned"]);
    expect(keys(ROLES.INSURANCE_OFFICER!)).toEqual(["all", "assigned", "returned", "claims"]);
    expect(keys(ROLES.ACCIDENT_MANAGER!)).toEqual(["all", "queue", "returned", "drafts", "claims"]);
    expect(keys(ROLES.DRIVER!)).toEqual(["all", "reported", "drafts"]);
    for (const r of ["FINANCE", "VIEWER", "USER"]) expect(keys(ROLES[r]!), r).toEqual(["all"]);
  });

  it("the queue is only for people who assign; drafts never for plain readers", () => {
    for (const [role, perms] of Object.entries(ROLES)) {
      expect(keys(perms).includes("queue"), role).toBe(perms.includes("accidents.assign"));
      if (!perms.some((p) => ["accidents.create", "accidents.update", "accidents.assign", "accidents.close"].includes(p))) expect(keys(perms).includes("drafts"), role).toBe(false);
    }
  });

  it("every tab key is a valid view and unknown values are not", () => {
    for (const k of ["all", "reported", "assigned", "queue", "returned", "drafts", "claims"]) expect(isTabKey(k)).toBe(true);
    for (const k of [null, "", "everything", "ALL", "queue;drop"]) expect(isTabKey(k as string | null)).toBe(false);
  });

  it("tab labels are real text in both languages", () => {
    const all = ["all", "reported", "assigned", "queue", "returned", "drafts", "claims"] as const;
    for (const loc of ["ar", "en"] as const) {
      setLocale(loc);
      const labels = accidentTabs(() => true, true).map((x) => x.label);
      expect(labels).toHaveLength(all.length);
      for (const l of labels) expect(l).not.toMatch(/^accidentFlow\./);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("labels", () => {
  it("every stage, repair decision, claim status and document has a label in both languages, none equal to its code", () => {
    for (const loc of ["ar", "en"] as const) {
      setLocale(loc);
      for (const s of STAGES) { expect(stageLabel(s), s).not.toBe(s); expect(stageLabel(s)).not.toMatch(/^accidentFlow/); expect(nextActionLabel(s), s).not.toMatch(/^accidentFlow/); }
      for (const d of REPAIR_DECISIONS) expect(repairDecisionLabel(d)).not.toMatch(/^accidentFlow|—/);
      for (const c of CLAIM_STATUSES) expect(claimStatusLabel(c)).not.toBe(c);
      for (const c of DOC_CATEGORIES) expect(docLabel(c), c).not.toMatch(/^accidentFlow|^[A-Z_]+$/);
      for (const code of REQUIREMENT_CODES) expect(requirementText(code), code).not.toMatch(/^accidentFlow|Unknown|غير معروف/);
    }
  });

  it("the English texts of the workflow have no Arabic and differ from the Arabic ones", () => {
    const k = Object.keys(ar).filter((x) => x.startsWith("accidentFlow."));
    expect(k.length).toBeGreaterThan(150);
    for (const key of k) {
      expect(/[؀-ۿ]/.test(en[key as keyof typeof en]), key).toBe(false);
      expect(en[key as keyof typeof en], key).not.toBe(ar[key as keyof typeof ar]);
    }
  });

  it("unknown values degrade to the raw value, never to a broken label", () => {
    expect(stageLabel("SOMETHING")).toBe("SOMETHING");
    expect(docLabel("X_DOC")).toBe("X_DOC");
    expect(claimStatusLabel("NOPE")).toBe("NOPE");
    expect(repairDecisionLabel(null)).toBe("—");
    expect(requirementText("something.new")).toContain("something.new");
  });

  it("the requirement code for a document uses the document's name", () => {
    expect(requirementText("attachment:DRIVER_LICENSE")).toContain(docLabel("DRIVER_LICENSE"));
    setLocale("en");
    expect(requirementText("attachment:NAJM_REPORT")).toBe("Najm / traffic report (required document)");
  });
});

const base = (over: Partial<CaseDetail> = {}): CaseDetail => ({ workflowStage: "DRAFT", repairDecision: null, claim: null, requirements: [], ...over }) as CaseDetail;

describe("what the screen shows as missing (always the server's answer)", () => {
  it("the four required documents are the ones the server demands", () => {
    expect([...REQUIRED_DOCS]).toEqual(["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"]);
  });

  it("a draft lists the documents the server says are missing, not what the screen can see", () => {
    const d = base({ requirements: [{ to: "AWAITING_TECHNICAL", missing: ["attachment:DRIVER_LICENSE", "attachment:NAJM_REPORT"] }] });
    expect(missingDocuments(d)).toEqual(["DRIVER_LICENSE", "NAJM_REPORT"]);
    expect(missingDocuments(base())).toEqual([]);
    expect(missingFor(d, "AWAITING_ESTIMATES")).toEqual([]);
  });

  it("pending items follow the step the case is heading for", () => {
    const req = [
      { to: "AWAITING_ESTIMATES", missing: ["technical.repairDecision"] },
      { to: "AWAITING_INSURANCE", missing: ["technical.no_repair_decision", "technical.notes"] },
    ] as CaseDetail["requirements"];
    expect(pendingMissing(base({ workflowStage: "AWAITING_TECHNICAL", requirements: req }))).toEqual(["technical.repairDecision"]);
    expect(pendingMissing(base({ workflowStage: "AWAITING_TECHNICAL", repairDecision: "NOT_NEEDED", requirements: req }))).toEqual(["technical.no_repair_decision", "technical.notes"]);
    // the resolution is typed in the closing dialog, so it is not listed
    expect(pendingMissing(base({ workflowStage: "AWAITING_FINAL_CLOSURE", requirements: [{ to: "CLOSED", missing: ["resolution", "repair.documentation"] }] }))).toEqual(["repair.documentation"]);
    // claim in progress: the next step depends on the claim's outcome; before a decision nothing is listed
    const claim = (status: string) => ({ status }) as CaseDetail["claim"];
    const claimReq = [{ to: "AWAITING_COMPENSATION_PROOF", missing: ["claim.approved"] }, { to: "AWAITING_FINAL_CLOSURE", missing: ["claim.rejected"] }] as CaseDetail["requirements"];
    expect(pendingMissing(base({ workflowStage: "CLAIM_IN_PROGRESS", claim: claim("PROCESSING"), requirements: claimReq }))).toEqual([]);
    expect(pendingMissing(base({ workflowStage: "CLAIM_IN_PROGRESS", claim: claim("APPROVED"), requirements: claimReq }))).toEqual(["claim.approved"]);
    expect(pendingMissing(base({ workflowStage: "CLOSED" }))).toEqual([]);
  });
});

describe("small rules", () => {
  it("who has to act, in words", () => {
    expect(requiredActorText(null)).toBe("—");
    expect(requiredActorText({ type: "USER", permission: "p", userId: "u", name: "سالم" })).toContain("سالم");
    expect(requiredActorText({ type: "QUEUE", permission: "accidents.assign", userId: null, name: null })).toContain("الإسناد");
    expect(requiredActorText({ type: "PROJECT_MANAGER", permission: "p", userId: "u", name: "منى" })).toContain("منى");
    expect(requiredActorText({ type: "PROJECT_MANAGER", permission: "p", userId: null, name: null })).toBe("مدير المشروع");
    setLocale("en");
    expect(requiredActorText({ type: "ROLE", permission: "accidents.close", userId: null, name: null })).toBe("Holders of the final closure permission");
  });

  it("a case can only be returned to an earlier stage", () => {
    expect(returnTargetsFrom("AWAITING_TECHNICAL")).toEqual([]);
    expect(returnTargetsFrom("AWAITING_INSURANCE")).toEqual(["AWAITING_TECHNICAL", "AWAITING_ESTIMATES"]);
    expect(returnTargetsFrom("AWAITING_FINAL_CLOSURE")).toEqual(["AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF"]);
  });

  it("the draft body leaves out empty optional fields and never sends a driver that was not chosen", () => {
    const v = { vehicleId: "v1", driverId: "", occurredAt: "2026-06-14T18:00", location: "  ", description: "  صدمة  ", severity: "MINOR", responsibility: "UNKNOWN", policeReportNumber: "" };
    expect(draftBody(v, (x) => `iso:${x}`, null)).toEqual({ vehicleId: "v1", occurredAt: "iso:2026-06-14T18:00", description: "صدمة", severity: "MINOR", responsibility: "UNKNOWN" });
    expect(draftBody({ ...v, driverId: "d1", location: "الرياض", policeReportNumber: "P1" }, (x) => x, { lat: 24.7, lng: 46.6 })).toMatchObject({ driverId: "d1", location: "الرياض", policeReportNumber: "P1", latitude: 24.7, longitude: 46.6 });
  });

  it("recognises the server's requirements-not-met answer and nothing else", () => {
    expect(missingFromError({ code: "REQUIREMENTS_NOT_MET", details: { missing: ["a", "b"] } })).toEqual(["a", "b"]);
    expect(missingFromError({ code: "REQUIREMENTS_NOT_MET", details: {} })).toBeNull();
    expect(missingFromError({ code: "INVALID_TRANSITION", details: { missing: ["a"] } })).toBeNull();
    expect(missingFromError(null)).toBeNull();
  });
});
