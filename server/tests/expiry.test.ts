import { afterEach, describe, expect, it } from "vitest";
import { addDays, setClock, today } from "../src/lib/clock.js";
import { daysUntil, driverEffectiveStatus, expiryStatus, expiryWindow } from "../src/services/expiry.js";

afterEach(() => setClock(null));

describe("expiry rules", () => {
  it("applies the documented boundaries exactly", () => {
    const t = "2026-06-15";
    expect(expiryStatus("2026-06-14", t)).toBe("EXPIRED"); // yesterday
    expect(expiryStatus("2026-06-15", t)).toBe("EXPIRING_SOON"); // today
    expect(expiryStatus("2026-07-15", t)).toBe("EXPIRING_SOON"); // today + 30
    expect(expiryStatus("2026-07-16", t)).toBe("ACTIVE"); // today + 31
    expect(expiryStatus(null, t)).toBe("ACTIVE");
  });

  it("derives 'today' from the server clock in the business time zone", () => {
    // 22:30 UTC on June 14 is already June 15 in Riyadh (UTC+3).
    setClock(new Date("2026-06-14T22:30:00Z"));
    expect(today("Asia/Riyadh")).toBe("2026-06-15");
    expect(today("UTC")).toBe("2026-06-14");
    expect(expiryStatus("2026-06-14")).toBe("EXPIRED");
    expect(expiryWindow()).toEqual({ today: "2026-06-15", soonUntil: "2026-07-15" });
  });

  it("does date arithmetic across month/year boundaries", () => {
    expect(addDays("2026-12-20", 30)).toBe("2027-01-19");
    expect(addDays("2028-02-15", 14)).toBe("2028-02-29"); // leap year
    expect(daysUntil("2026-06-25", "2026-06-15")).toBe(10);
    expect(daysUntil("2026-06-10", "2026-06-15")).toBe(-5);
  });

  it("computes effective driver status", () => {
    const t = "2026-06-15";
    expect(driverEffectiveStatus("ACTIVE", "2027-01-01", "ACTIVE", t)).toBe("ACTIVE");
    expect(driverEffectiveStatus("ACTIVE", "2026-06-01", "ACTIVE", t)).toBe("EXPIRED");
    expect(driverEffectiveStatus("SUSPENDED", "2026-06-01", "ACTIVE", t)).toBe("SUSPENDED");
    expect(driverEffectiveStatus("ACTIVE", "2027-01-01", "ARCHIVED", t)).toBe("INACTIVE");
    expect(driverEffectiveStatus("ACTIVE", null, "ACTIVE", t)).toBe("ACTIVE");
  });
});
