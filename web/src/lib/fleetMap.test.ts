import { describe, expect, it } from "vitest";
import { agoLabel, diffFleet, durationLabel, filterFleet, fleetCounts, keepSelection, latestPerVehicle, markerSignature, motionOf, parseStatusParam, toFleet, toFleetVehicle, tripRange, type LatestLocation } from "./fleetMap";

const NOW = Date.parse("2026-06-15T09:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const row = (over: Partial<LatestLocation>): LatestLocation => ({
  vehicleId: "v1",
  plateNumber: "ABC 1234",
  plateArabic: "أ ب ج 1234",
  vehicleNumber: "FLEET-1",
  make: "Toyota",
  model: "Hiace",
  status: "ASSIGNED",
  projectId: "p-ruh",
  projectName: "مشروع الرياض",
  driverName: "محمد",
  currentDriverName: null,
  latitude: "24.713600",
  longitude: "46.675300",
  accuracy: "10.00",
  speed: "20.00", // m/s = 72 km/h
  heading: "90.00",
  recordedAt: ago(20),
  tripActive: true,
  openAccident: false,
  ...over,
});

describe("fleet map data transformation", () => {
  it("normalises an API row: m/s → km/h, age, labels, driver", () => {
    const v = toFleetVehicle(row({ currentDriverName: "محمد (السائق الحالي)" }), NOW)!;
    expect(v).toMatchObject({ id: "v1", plate: "ABC 1234", makeModel: "Toyota Hiace", projectName: "مشروع الرياض", driverName: "محمد (السائق الحالي)", lat: 24.7136, lng: 46.6753, speedKmh: 72, heading: 90, ageSeconds: 20, motion: "MOVING", state: "MOVING", alert: null });
  });

  it("never invents a position: rows with missing / invalid coordinates are dropped", () => {
    expect(toFleetVehicle(row({ latitude: "" }), NOW)).toBeNull();
    expect(toFleetVehicle(row({ longitude: "abc" }), NOW)).toBeNull();
    expect(toFleetVehicle(row({ latitude: "95" }), NOW)).toBeNull();
    expect(toFleet([row({}), row({ vehicleId: "v2", latitude: "" })], NOW).map((v) => v.id)).toEqual(["v1"]);
  });

  it("selects the latest location per vehicle", () => {
    const rows = [row({ recordedAt: ago(300), latitude: "24.1" }), row({ recordedAt: ago(10), latitude: "24.9" }), row({ vehicleId: "v2", recordedAt: ago(60) }), row({ recordedAt: ago(900), latitude: "24.5" })];
    const latest = latestPerVehicle(rows);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.vehicleId === "v1")!.latitude).toBe("24.9");
    expect(toFleet(rows, NOW).find((v) => v.id === "v1")!.lat).toBe(24.9);
  });
});

describe("marker status", () => {
  it("moving / stopped / offline from speed and age", () => {
    expect(motionOf(20, 72)).toBe("MOVING");
    expect(motionOf(20, 3)).toBe("STOPPED"); // GPS jitter
    expect(motionOf(20, null)).toBe("STOPPED");
    expect(motionOf(16 * 60, 72)).toBe("OFFLINE");
    expect(motionOf(10 * 60, 72, 5)).toBe("OFFLINE"); // custom threshold
    expect(toFleetVehicle(row({ speed: "0.50" }), NOW)!.state).toBe("STOPPED");
    expect(toFleetVehicle(row({ recordedAt: ago(3600) }), NOW)!.state).toBe("OFFLINE");
  });

  it("alerts win over motion but keep the motion state", () => {
    const acc = toFleetVehicle(row({ openAccident: true, speed: "0" }), NOW)!;
    expect(acc).toMatchObject({ state: "ALERT", motion: "STOPPED", alert: "حادث مفتوح" });
    expect(toFleetVehicle(row({ status: "ACCIDENT" }), NOW)!.alert).toBe("حادث مفتوح");
    const fast = toFleetVehicle(row({ speed: "40" }), NOW)!; // 144 km/h
    expect(fast).toMatchObject({ state: "ALERT", motion: "MOVING", alert: "تجاوز السرعة" });
    // an old overspeed reading is not a live alert
    expect(toFleetVehicle(row({ speed: "40", recordedAt: ago(7200) }), NOW)!.state).toBe("OFFLINE");
  });
});

describe("filtering, counts and selection", () => {
  const fleet = toFleet(
    [
      row({ vehicleId: "a", plateNumber: "RUH 1", projectId: "p-ruh", driverName: "فهد القحطاني" }),
      row({ vehicleId: "b", plateNumber: "RUH 2", projectId: "p-ruh", speed: "0", driverName: "ماجد" }),
      row({ vehicleId: "c", plateNumber: "JED 1", projectId: "p-jed", projectName: "مشروع جدة", recordedAt: ago(4000), driverName: "خالد" }),
      row({ vehicleId: "d", plateNumber: "JED 2", projectId: "p-jed", projectName: "مشروع جدة", openAccident: true, speed: "0", driverName: null }),
    ],
    NOW,
  );

  it("project filter keeps only that project's vehicles", () => {
    expect(filterFleet(fleet, { projectId: "p-ruh" }).map((v) => v.id)).toEqual(["a", "b"]);
    expect(filterFleet(fleet, { projectId: "p-jed" }).map((v) => v.id).sort()).toEqual(["c", "d"]);
    expect(filterFleet(fleet, { projectId: "p-none" })).toEqual([]);
  });

  it("status filter and vehicle / driver search", () => {
    expect(filterFleet(fleet, { status: "MOVING" }).map((v) => v.id)).toEqual(["a"]);
    expect(filterFleet(fleet, { status: "STOPPED" }).map((v) => v.id).sort()).toEqual(["b", "d"]);
    expect(filterFleet(fleet, { status: "OFFLINE" }).map((v) => v.id)).toEqual(["c"]);
    expect(filterFleet(fleet, { status: "ALERT" }).map((v) => v.id)).toEqual(["d"]);
    expect(filterFleet(fleet, { q: "jed1" }).map((v) => v.id)).toEqual(["c"]); // spaces/case ignored
    expect(filterFleet(fleet, { q: "القحطاني" }).map((v) => v.id)).toEqual(["a"]);
    expect(filterFleet(fleet, { q: "FLEET-1", projectId: "p-jed", status: "OFFLINE" }).map((v) => v.id)).toEqual(["c"]);
  });

  it("counts moving / stopped / offline / alerts and vehicles without GPS", () => {
    expect(fleetCounts(fleet, 6)).toEqual({ total: 6, located: 4, moving: 1, stopped: 2, offline: 1, alerts: 1, noGps: 2 });
    expect(fleetCounts([], 0)).toEqual({ total: 0, located: 0, moving: 0, stopped: 0, offline: 0, alerts: 0, noGps: 0 });
  });

  it("keeps the selected vehicle while visible and drops it when filtered out", () => {
    expect(keepSelection("a", filterFleet(fleet, { projectId: "p-ruh" }))).toBe("a");
    expect(keepSelection("a", filterFleet(fleet, { projectId: "p-jed" }))).toBeNull();
    expect(keepSelection(null, fleet)).toBeNull();
  });

  it("parses the dashboard status deep-link", () => {
    expect(parseStatusParam("MOVING")).toBe("MOVING");
    expect(parseStatusParam("OFFLINE")).toBe("OFFLINE");
    expect(parseStatusParam("DROP TABLE")).toBe("");
    expect(parseStatusParam(null)).toBe("");
  });
});

describe("GPS update behaviour", () => {
  it("a refresh only touches markers whose position / state changed", () => {
    const before = toFleet([row({ vehicleId: "a" }), row({ vehicleId: "b", speed: "0" }), row({ vehicleId: "c" })], NOW);
    const prev = new Map(before.map((v) => [v.id, markerSignature(v)]));
    const after = toFleet(
      [
        row({ vehicleId: "a" }), // unchanged
        row({ vehicleId: "b", speed: "15" }), // started moving
        row({ vehicleId: "d" }), // new vehicle reported
      ],
      NOW + 15_000,
    );
    expect(diffFleet(prev, after)).toEqual({ added: ["d"], updated: ["b"], removed: ["c"], unchanged: ["a"] });
    const moved = toFleet([row({ vehicleId: "a", latitude: "24.720000" })], NOW);
    expect(diffFleet(prev, moved).updated).toEqual(["a"]);
  });

  it("labels the time since the last update", () => {
    expect(agoLabel(2)).toBe("الآن");
    expect(agoLabel(20)).toBe("منذ 20 ثانية");
    expect(agoLabel(125)).toBe("منذ 2 دقيقة");
    expect(agoLabel(3 * 3600)).toBe("منذ 3 ساعة");
    expect(agoLabel(3 * 86400)).toBe("منذ 3 يوم");
  });
});

describe("trip history ranges", () => {
  it("today / yesterday / last 7 days / custom", () => {
    expect(tripRange("today", "2026-03-01")).toEqual({ from: "2026-03-01", to: "2026-03-01" });
    expect(tripRange("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(tripRange("7d", "2026-03-01")).toEqual({ from: "2026-02-23", to: "2026-03-01" });
    expect(tripRange("custom", "2026-03-01", { from: "2026-02-10", to: "2026-02-01" })).toEqual({ from: "2026-02-01", to: "2026-02-10" });
    expect(tripRange("custom", "2026-03-01", { from: "", to: "" })).toEqual({ from: "2026-03-01", to: "2026-03-01" });
  });

  it("formats trip durations", () => {
    expect(durationLabel("2026-01-01T08:00:00Z", "2026-01-01T08:45:00Z")).toBe("45 د");
    expect(durationLabel("2026-01-01T08:00:00Z", "2026-01-01T10:05:00Z")).toBe("2 س 5 د");
    expect(durationLabel("2026-01-01T08:00:00Z", null, Date.parse("2026-01-01T08:10:00Z"))).toBe("10 د");
    expect(durationLabel("bad", null)).toBe("—");
  });
});
