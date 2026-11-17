import { describe, expect, it } from "vitest";
import { documentRows, fileKind, formatFileSize, otherDocuments, type DocumentFile, type DocumentSlot } from "./accidentDocuments";

const file = (id: string, category: string, extra: Partial<DocumentFile> = {}): DocumentFile => ({ id, category, fileName: `${id}.pdf`, mimeType: "application/pdf", sizeBytes: 1000, createdAt: "2026-11-01T10:00:00Z", ...extra });
const slot = (category: DocumentSlot["category"], currentId: string | null, replacedCount = 0): DocumentSlot => ({ category, status: currentId ? "UPLOADED" : "MISSING", currentId, replacedCount, updatedAt: null });

describe("accident documents", () => {
  it("formats sizes and kinds", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(250 * 1024)).toBe("250 KB");
    expect(formatFileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatFileSize(-1)).toBe("—");
    expect(fileKind("application/pdf")).toBe("pdf");
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("image/svg+xml")).toBe("other"); // never previewed inline
    expect(fileKind("text/html")).toBe("other");
  });

  it("builds one independent row per core document with its status, current file and history", () => {
    const files = [
      file("n1", "NAJM_REPORT", { supersededAt: "2026-11-02T10:00:00Z" }),
      file("n2", "NAJM_REPORT"),
      file("l1", "DRIVER_LICENSE"),
      file("p1", "PHOTO"),
    ];
    const rows = documentRows([slot("NAJM_REPORT", "n2", 1), slot("DRIVER_ID", null), slot("DRIVER_LICENSE", "l1"), slot("VEHICLE_REGISTRATION", null)], files);
    expect(rows.map((r) => [r.category, r.status])).toEqual([["NAJM_REPORT", "UPLOADED"], ["DRIVER_ID", "MISSING"], ["DRIVER_LICENSE", "UPLOADED"], ["VEHICLE_REGISTRATION", "MISSING"]]);
    expect(rows[0]!.current?.id).toBe("n2");
    expect(rows[0]!.history.map((f) => f.id)).toEqual(["n1"]);
    expect(rows[1]!.current).toBeNull();
    expect(rows[2]!.history).toEqual([]);
  });

  it("reads a slot whose file the caller cannot see as missing, and lists other documents separately", () => {
    const rows = documentRows([slot("DRIVER_ID", "hidden")], [file("p1", "PHOTO")]);
    expect(rows[0]).toMatchObject({ status: "MISSING", current: null });
    expect(otherDocuments([file("p1", "PHOTO"), file("o1", "OTHER", { supersededAt: "2026-11-02T00:00:00Z" }), file("n1", "NAJM_REPORT")]).map((f) => f.id)).toEqual(["p1"]);
  });
});
