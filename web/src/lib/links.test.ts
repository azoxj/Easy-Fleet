import { describe, expect, it } from "vitest";
import { entityLink, monthRange, withRange } from "./links";

const ID = "3f2a1c4e-8b7d-4e21-9a55-0c1d2e3f4a5b";

describe("record links", () => {
  it("maps audit entities to their detail pages", () => {
    expect(entityLink("vehicle", ID)).toBe(`/vehicles/${ID}`);
    expect(entityLink("maintenance_request", ID)).toBe(`/maintenance/${ID}`);
    expect(entityLink("invoice", ID)).toBe(`/finance/invoices/${ID}`);
    expect(entityLink("handover_session", ID)).toBe(`/handovers/${ID}`);
  });
  it("returns null for entities without a page or non-uuid ids", () => {
    expect(entityLink("session", ID)).toBeNull();
    expect(entityLink("vehicle", null)).toBeNull();
    expect(entityLink("vehicle", "../../admin")).toBeNull();
  });
  it("turns a chart month into a date range", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-13")).toBeNull();
    expect(withRange("/maintenance", "2026-04")).toBe("/maintenance?from=2026-04-01&to=2026-04-30");
    expect(withRange("/fuel", "bad")).toBe("/fuel");
  });
});
