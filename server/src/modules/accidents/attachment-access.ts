import { eq } from "drizzle-orm";
import type { Access } from "../../auth/access.js";
import type { DbOrTx } from "../../db/client.js";
import { accidentAssignments, accidents } from "../../db/schema/index.js";
import { canViewAttachment, type SensitiveAccessInput } from "./attachments-policy.js";
import { handlesProject, holdsScoped, isManager } from "./visibility.js";

type CaseRow = Pick<typeof accidents.$inferSelect, "id" | "projectId" | "createdBy" | "reportedBy" | "assignedTo" | "workflowStage">;

/** Everything the attachment policy needs to decide for this user on this accident. */
export async function sensitiveInputFor(db: DbOrTx, a: Access, acc: CaseRow): Promise<SensitiveAccessInput> {
  const scope = a.scopeOf("accidents.documents.sensitive") ?? undefined;
  const participantish = acc.createdBy === a.userId || acc.reportedBy === a.userId || acc.assignedTo === a.userId;
  const inScope = scope === "ALL" || (scope === "PROJECT" && (a.isMemberOf(acc.projectId) || acc.assignedTo === a.userId)) || (scope === "ASSIGNED" && participantish);
  // Only actual assignees are previous handlers. Transition actors may merely
  // have created or advanced the case without ever owning its assignment.
  const assigned = await db
    .select({ u: accidentAssignments.assignedTo })
    .from(accidentAssignments)
    .where(eq(accidentAssignments.accidentId, acc.id));
  const previousHandlers = [...new Set(
    assigned.map((r) => r.u).filter((x): x is string => !!x && x !== acc.assignedTo)
  )];
  const financeAuthorized = holdsScoped(
    a,
    "accidents.compensation.confirm",
    acc.projectId
  );
  return {
    userId: a.userId,
    scope,
    inScope,
    isFinanceActor: financeAuthorized,
    accident: { createdBy: acc.createdBy, reportedBy: acc.reportedBy, assignedTo: acc.assignedTo },
    previousHandlers,
    stage: acc.workflowStage ?? "",
    isInsuranceOfficer: a.roleKeys.includes("INSURANCE_OFFICER"),
    isManager: isManager(a, acc),
    handlesProject: handlesProject(a, acc),
  };
}

/** Keeps only the attachments the user may see (the same call for lists, detail and download). */
export function visibleAttachments<T extends { category: string; uploadedBy: string | null }>(rows: T[], input: SensitiveAccessInput): T[] {
  return rows.filter((r) => canViewAttachment(r.category, input, r.uploadedBy));
}

export { holdsScoped };
