import { describe, expect, it, vi } from "vitest";
import { apiUpload, setCsrfToken } from "./api";
import {
  ACTION_LABEL,
  ACTION_PATH,
  ATTACHMENT_CATEGORY,
  MAINTENANCE_PRIORITY,
  MAINTENANCE_STATUS,
  QUOTE_STATUS,
  REASON_ACTIONS,
  STEPS,
  stepIndex,
  sumMoney,
  validateCreate,
  validateLabor,
  validatePart,
  validateQuote,
  validateReason,
} from "./maintenance";
import { NAV, visibleNav } from "./permissions";
import type { Me } from "./types";

describe("maintenance labels & actions", () => {
  it("cover every server enum value and action", () => {
    expect(Object.keys(MAINTENANCE_STATUS)).toEqual(["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED", "REJECTED", "CLOSED"]);
    expect(Object.keys(MAINTENANCE_PRIORITY)).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    expect(Object.keys(QUOTE_STATUS)).toEqual(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"]);
    expect(Object.keys(ATTACHMENT_CATEGORY)).toEqual(["DAMAGE_PHOTO", "INSPECTION_REPORT", "QUOTE", "INVOICE", "REPAIR_PHOTO", "OTHER"]);
    const serverActions = ["startInspection", "completeInspection", "approve", "reject", "startRepair", "markReady", "acceptHandover", "rejectHandover", "close"];
    for (const a of serverActions) {
      expect(ACTION_LABEL[a], a).toBeTruthy();
      expect(ACTION_PATH[a], a).toMatch(/^[a-z-]+$/);
    }
    expect(ACTION_LABEL.assign).toBeTruthy();
    expect([...REASON_ACTIONS].sort()).toEqual(["reject", "rejectHandover"]);
  });

  it("maps statuses onto the stepper", () => {
    expect(stepIndex("REQUESTED")).toBe(0);
    expect(stepIndex("IN_REPAIR")).toBe(STEPS.indexOf("IN_REPAIR"));
    expect(stepIndex("CLOSED")).toBe(STEPS.length - 1);
    expect(stepIndex("ACCEPTED")).toBeGreaterThan(stepIndex("READY_FOR_HANDOVER"));
    expect(stepIndex("REJECTED")).toBe(-1);
  });
});

describe("maintenance form validation (client UX)", () => {
  it("create: vehicle, issue and priority required; odometer ≥ 0 integer", () => {
    expect(validateCreate({ vehicleId: "", issue: "", priority: "", odometer: "" })).toMatchObject({ vehicleId: expect.any(String), issue: expect.any(String), priority: expect.any(String) });
    expect(validateCreate({ vehicleId: "v", issue: "عطل الفرامل", priority: "HIGH", odometer: "-3" }).odometer).toBeTruthy();
    expect(validateCreate({ vehicleId: "v", issue: "عطل الفرامل", priority: "HIGH", odometer: "12.5" }).odometer).toBeTruthy();
    expect(validateCreate({ vehicleId: "v", issue: "عطل الفرامل", priority: "HIGH", odometer: "" })).toEqual({});
  });

  it("parts: quantity > 0, price ≥ 0", () => {
    expect(validatePart({ partName: "فحمات", quantity: "0", unitPrice: "10" }).quantity).toBeTruthy();
    expect(validatePart({ partName: "فحمات", quantity: "2", unitPrice: "-1" }).unitPrice).toBeTruthy();
    expect(validatePart({ partName: "فحمات", quantity: "2", unitPrice: "0" })).toEqual({});
  });

  it("labor: hours > 0", () => {
    expect(validateLabor({ description: "تركيب", hours: "0", hourlyRate: "50" }).hours).toBeTruthy();
    expect(validateLabor({ description: "تركيب", hours: "1.5", hourlyRate: "50" })).toEqual({});
  });

  it("quote: amount required, validUntil not in the past", () => {
    expect(validateQuote({ amount: "", validUntil: "" }, "2026-06-15").amount).toBeTruthy();
    expect(validateQuote({ amount: "100", validUntil: "2026-06-14" }, "2026-06-15").validUntil).toBeTruthy();
    expect(validateQuote({ amount: "100", validUntil: "2026-06-15" }, "2026-06-15")).toEqual({});
  });

  it("reject reason is required", () => {
    expect(validateReason("  ")).toBeTruthy();
    expect(validateReason("لا يزال هناك صوت")).toBeNull();
  });

  it("sums money without float drift", () => {
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
    expect(sumMoney(["300.50", "150.00", null])).toBe("450.50");
  });
});

describe("maintenance UI permissions", () => {
  const me = (permissions: Me["permissions"]): Me => ({ id: "1", email: "a@example.test", name: "a", mustChangePassword: false, roles: [], permissions, projectIds: [], csrfToken: "t" });
  it("shows the maintenance menu only with maintenance.read", () => {
    expect(visibleNav(me({ "maintenance.read": "ASSIGNED" }), NAV).map((n) => n.to)).toContain("/maintenance");
    expect(visibleNav(me({ "vehicles.read": "ASSIGNED" }), NAV).map((n) => n.to)).not.toContain("/maintenance");
  });

  it("attachment uploads use POST with CSRF", async () => {
    setCsrfToken("tok");
    const f = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 201 }));
    await apiUpload("/maintenance/x/attachments?category=DAMAGE_PHOTO", new File(["%PDF-"], "a.pdf", { type: "application/pdf" }), f, "POST");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/maintenance/x/attachments?category=DAMAGE_PHOTO");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
  });
});
