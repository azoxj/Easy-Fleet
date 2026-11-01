export type OfficerCandidate = { userId: string; projectId: string | null; active: boolean; holdsPermission: boolean };

export type AssignmentDecision =
  | { mode: "AUTO"; userId: string; level: "PROJECT" | "ORGANIZATION" }
  | { mode: "QUEUE"; reason: "NO_OFFICER" | "MULTIPLE_OFFICERS" };

/**
 * Picks the officer for a stage. Project-level designations win over organisation-wide ones.
 * Exactly one eligible officer at the winning level is auto-assigned; zero or several go to the
 * queue for a manager to assign: nothing is ever assigned at random.
 * An officer who is inactive or no longer holds the stage permission is not eligible.
 */
export function decideAssignment(candidates: OfficerCandidate[], projectId: string | null): AssignmentDecision {
  const eligible = candidates.filter((c) => c.active && c.holdsPermission);
  const atProject = projectId ? [...new Set(eligible.filter((c) => c.projectId === projectId).map((c) => c.userId))] : [];
  if (atProject.length === 1) return { mode: "AUTO", userId: atProject[0]!, level: "PROJECT" };
  if (atProject.length > 1) return { mode: "QUEUE", reason: "MULTIPLE_OFFICERS" };
  const atOrg = [...new Set(eligible.filter((c) => c.projectId === null).map((c) => c.userId))];
  if (atOrg.length === 1) return { mode: "AUTO", userId: atOrg[0]!, level: "ORGANIZATION" };
  return { mode: "QUEUE", reason: atOrg.length > 1 ? "MULTIPLE_OFFICERS" : "NO_OFFICER" };
}
