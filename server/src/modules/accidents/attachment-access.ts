import { eq } from "drizzle-orm";
import type { Access } from "../../auth/access.js";
import type { DbOrTx } from "../../db/client.js";
import { accidentAssignments, accidentTransitions, accidents } from "../../db/schema/index.js";
import { canViewAttachment, type SensitiveAccessInput } from "./attachments-policy.js";
import { handlesProject, holdsScoped, isManager } from "./visibility.js";

type CaseRow = Pick<typeof accidents.$inferSelect, "id" | "projectId" | "createdBy" | "reportedBy" | "assignedTo">;

/** Everything the attachment policy needs to decide for this user on this accident. */
export async function sensitiveInputFor(db: DbOrTx, a: Access, acc: CaseRow): Promise<SensitiveAccessInput> {
  const scope = a.scopeOf("accidents.documents.sensitive") ?? undefined;
  const participantish = acc.createdBy === a.userId || acc.reportedBy === a.userId || acc.assignedTo === a.userId;
  const inScope = scope === "ALL" || (scope === "PROJECT" && (a.isMemberOf(acc.projectId) || acc.assignedTo === a.userId)) || (scope === "ASSIGNED" && participantish);
  const [assigned, actors] = await Promise.all([
    db.select({ u: accidentAssignments.assignedTo }).from(accidentAssignments).where(eq(accidentAssignments.accidentId, acc.id)),
    db.select({ u: accidentTransitions.actorId }).from(accidentTransitions).where(eq(accidentTransitions.accidentId, acc.id)),
  ]);
  const previousHandlers = [...new Set([...assigned.map((r) => r.u), ...actors.map((r) => r.u)].filter((x): x is string => !!x))];
  return {
    userId: a.userId,
    scope,
    inScope,
    accident: { createdBy: acc.createdBy, reportedBy: acc.reportedBy, assignedTo: acc.assignedTo },
    previousHandlers,
    isManager: isManager(a, acc),
    handlesProject: handlesProject(a, acc),
  };
}

/** Keeps only the attachments the user may see (the same call for lists, detail and download). */
export function visibleAttachments<T extends { category: string; uploadedBy: string | null }>(rows: T[], input: SensitiveAccessInput): T[] {
  return rows.filter((r) => canViewAttachment(r.category, input, r.uploadedBy));
}

export { holdsScoped };
