import type { Access } from "../../auth/access.js";
import type { DbOrTx } from "../../db/client.js";
import { sensitiveInputFor } from "./attachment-access.js";
import { handlesProject, holdsScoped, isManager } from "./visibility.js";

type CaseRow = Parameters<typeof sensitiveInputFor>[2];

/**
 * Previous handlers may follow the case, but cannot read its full details
 * after responsibility has been transferred.
 */
export async function shouldShowCaseSummaryOnly(
  db: DbOrTx,
  access: Access,
  accident: CaseRow,
): Promise<boolean> {
  if (accident.workflowStage === null) return false;
  if (isManager(access, accident)) return false;
  if (holdsScoped(access, "accidents.compensation.confirm", accident.projectId)) return false;
  if (accident.workflowStage === "DRAFT" && handlesProject(access, accident)) return false;
  if (accident.assignedTo === access.userId) return false;
  if (handlesProject(access, accident)) return true;

  const input = await sensitiveInputFor(db, access, accident);
  return input.previousHandlers.includes(access.userId);
}

export function caseSummary<T extends {
  id: string;
  number: number;
  vehicleId: string;
  projectId: string | null;
  workflowStage: string | null;
  status: string;
  updatedAt: Date;
}>(accident: T, extra: {
  plateNumber?: string | null;
  projectName?: string | null;
} = {}) {
  return {
    id: accident.id,
    number: accident.number,
    label: `ACC-${accident.number}`,
    vehicleId: accident.vehicleId,
    projectId: accident.projectId,
    plateNumber: extra.plateNumber ?? null,
    projectName: extra.projectName ?? null,
    workflowStage: accident.workflowStage,
    status: accident.status,
    updatedAt: accident.updatedAt,
  };
}
