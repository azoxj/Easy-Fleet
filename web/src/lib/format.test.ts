import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatNumber, timeAgo } from "./format";
import { fieldErrors } from "./forms";
import { ApiError } from "./api";

describe("formatting", () => {
  it("formats numbers and money with Latin digits", () => {
    expect(formatNumber(12500)).toBe("12,500");
    expect(formatMoney("8500.5")).toBe("8,500.5 ريال");
    expect(formatMoney(null)).toBe("—");
    expect(formatNumber("abc")).toBe("—");
  });

  it("formats dates and handles empty values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-01-15")).toMatch(/2026/);
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("renders relative time in Arabic", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(timeAgo("2026-09-24T11:59:30Z", now)).toBe("الآن");
    expect(timeAgo("2026-09-24T11:30:00Z", now)).toBe("منذ 30 دقيقة");
    expect(timeAgo("2026-09-24T09:00:00Z", now)).toBe("منذ 3 ساعة");
  });

  it("maps server validation details to field errors", () => {
    const err = new ApiError(400, "VALIDATION_ERROR", "x", [{ path: "plateNumber", message: "مطلوب" }, { path: "plateNumber", message: "ثاني" }]);
    expect(fieldErrors(err)).toEqual({ plateNumber: "مطلوب" });
    expect(fieldErrors(new Error("x"))).toEqual({});
  });
});
