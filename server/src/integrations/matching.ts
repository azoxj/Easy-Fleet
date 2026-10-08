/**
 * Vehicle matching for imported records. Matching is by plate number only and never
 * creates a vehicle: anything but exactly one candidate goes to the review queue.
 *
 * Plate normalization is intentionally NOT implemented here. A future normalization
 * service plugs in behind `VehicleMatcher` (it returns the ids of the vehicles whose
 * plate corresponds to the raw plate) without touching the decision or the queue.
 */
export interface VehicleMatcher {
  findVehicleIdsByPlate(organizationId: string, plateRaw: string): Promise<string[]>;
}

export type MatchDecision =
  | { kind: "MATCHED"; vehicleId: string }
  | { kind: "REVIEW"; reason: "NO_MATCH" | "AMBIGUOUS"; candidates: string[] };

export function decideMatch(candidateVehicleIds: readonly string[]): MatchDecision {
  const ids = [...new Set(candidateVehicleIds)];
  if (ids.length === 1) return { kind: "MATCHED", vehicleId: ids[0]! };
  return { kind: "REVIEW", reason: ids.length === 0 ? "NO_MATCH" : "AMBIGUOUS", candidates: ids };
}
