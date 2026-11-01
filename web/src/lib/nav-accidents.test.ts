import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "./permissions";

/**
 * Guards the navigation contract for the accident workflow: its screens live inside the existing "Accidents" section
 * (one entry, /accidents) and never add a second menu entry or touch "Assignment tracking".
 */
const items = NAV_GROUPS.flatMap((g) => g.items);

describe("navigation keeps one Accidents entry and one assignment tracking entry", () => {
  it("has exactly one accidents entry, gated by accidents.read, and no separate accident-cases/claims/insurance entries", () => {
    const accident = items.filter((i) => /accident/i.test(i.to));
    expect(accident).toHaveLength(1);
    expect(accident[0]).toMatchObject({ to: "/accidents", perm: "accidents.read" });
    expect(items.some((i) => /accident-cases|claims|insurance-claims|accident-queue/i.test(i.to))).toBe(false);
  });

  it("keeps assignment tracking as the one generic /assignments entry, still gated by the assignments permissions only", () => {
    const tracking = items.filter((i) => i.to === "/assignments");
    expect(tracking).toHaveLength(1);
    expect(tracking[0]!.anyOf).toEqual(["assignments.read", "assignments.create"]);
    expect(items.filter((i) => /assignment/i.test(i.to) && i.to !== "/my-assignments" && i.to !== "/assignments")).toEqual([]);
  });

  it("has no duplicated destination and no duplicated label", () => {
    const to = items.map((i) => i.to);
    expect(new Set(to).size).toBe(to.length);
    const labels = items.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
