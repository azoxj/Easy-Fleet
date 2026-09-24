import { describe, expect, it, vi } from "vitest";
import { apiUpload, fileUrl, setCsrfToken } from "./api";
import { COVERAGE_TYPE, DOCUMENT_TYPE, DRIVER_STATUS, EMPLOYEE_STATUS, EXPIRY_STATUS, LICENSE_TYPE } from "./labels";

describe("file upload client", () => {
  it("sends the raw file with CSRF token, content type and encoded name", async () => {
    setCsrfToken("tok");
    const f = vi.fn(async () => new Response(JSON.stringify({ data: { fileName: "a.pdf" } }), { status: 201 }));
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "استمارة 1.pdf", { type: "application/pdf" });
    await apiUpload("/vehicle-documents/x/file", file, f);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(url).toBe("/api/vehicle-documents/x/file");
    expect(init.method).toBe("PUT");
    expect(h["X-CSRF-Token"]).toBe("tok");
    expect(h["Content-Type"]).toBe("application/pdf");
    expect(decodeURIComponent(h["X-File-Name"]!)).toBe("استمارة 1.pdf");
    expect(init.body).toBe(file);
  });

  it("surfaces server validation errors", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "نوع الملف غير مسموح" } }), { status: 400 }));
    await expect(apiUpload("/x", new File(["MZ"], "a.exe"), f)).rejects.toMatchObject({ status: 400, message: "نوع الملف غير مسموح" });
  });

  it("builds same-origin download URLs only", () => {
    expect(fileUrl("/insurance/1/file")).toBe("/api/insurance/1/file");
  });
});

describe("Sprint 2 labels", () => {
  it("cover every server enum value", () => {
    expect(Object.keys(EMPLOYEE_STATUS)).toEqual(["ACTIVE", "INACTIVE", "SUSPENDED", "ARCHIVED"]);
    expect(Object.keys(DRIVER_STATUS)).toEqual(["ACTIVE", "EXPIRED", "SUSPENDED", "INACTIVE"]);
    expect(Object.keys(EXPIRY_STATUS)).toEqual(["ACTIVE", "EXPIRING_SOON", "EXPIRED"]);
    expect(Object.keys(DOCUMENT_TYPE)).toEqual(["REGISTRATION", "INSURANCE", "LICENSE", "WARRANTY", "OWNERSHIP", "OTHER"]);
    expect(Object.keys(COVERAGE_TYPE)).toEqual(["THIRD_PARTY", "COMPREHENSIVE", "OTHER"]);
    expect(Object.keys(LICENSE_TYPE)).toEqual(["PRIVATE", "PUBLIC", "HEAVY", "MOTORCYCLE", "OTHER"]);
  });
});
