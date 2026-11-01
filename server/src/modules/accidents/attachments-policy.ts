import type { Scope } from "../../auth/permissions.js";

export const ATTACHMENT_CATEGORIES = [
  // Legacy categories (unchanged behaviour).
  "PHOTO",
  "POLICE_REPORT",
  "INSURANCE",
  "REPAIR_INVOICE",
  "OTHER",
  // Case documents.
  "NAJM_REPORT",
  "DRIVER_ID",
  "DRIVER_LICENSE",
  "VEHICLE_REGISTRATION",
  "ESTIMATE",
  "CLAIM_FORM",
  "INSURER_DECISION",
  "COMPENSATION_PROOF",
  /** Proof that the repair was carried out (certificate / photos); REPAIR_INVOICE serves too. */
  "REPAIR_COMPLETION",
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

/** Must all be present (not superseded) before a draft can be submitted. */
export const REQUIRED_FOR_SUBMIT: readonly AttachmentCategory[] = ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"];

/**
 * Personal / financial documents: need accidents.documents.sensitive AND participation in the case.
 * POLICE_REPORT and INSURANCE are legacy categories that are sensitive too. NOTE: no route applies this yet
 * (Phase 1 changes no access); see docs/ACCIDENTS-PHASE1.md for the expected access change before it is enforced.
 */
export const SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set([
  "POLICE_REPORT",
  "INSURANCE",
  "DRIVER_ID",
  "DRIVER_LICENSE",
  "VEHICLE_REGISTRATION",
  "CLAIM_FORM",
  "INSURER_DECISION",
  "COMPENSATION_PROOF",
]);

export const isSensitiveCategory = (category: string) => SENSITIVE_CATEGORIES.has(category);

export function missingRequiredCategories(present: Iterable<string>): AttachmentCategory[] {
  const have = new Set(present);
  return REQUIRED_FOR_SUBMIT.filter((c) => !have.has(c));
}

export type SensitiveAccessInput = {
  userId: string;
  /** Scope of accidents.documents.sensitive for the user, undefined when not granted. */
  scope: Scope | undefined;
  /** Whether the user's scope reaches the accident's project. */
  inScope: boolean;
  accident: { createdBy: string; reportedBy: string | null; assignedTo: string | null };
  /** Users who handled the case earlier (transition actors). */
  previousHandlers: readonly string[];
  /** Holds accidents.assign or accidents.close (the manager). */
  isManager: boolean;
  /** Holds accidents.update reaching this accident (the project manager who completes the case). Counts as a participant. */
  handlesProject?: boolean;
};

/**
 * Least privilege: the permission is necessary but not sufficient. The user must also be able to
 * reach the accident (scope) and be a participant: creator, reporter, current/previous assignee or manager.
 */
export function canViewSensitiveDocument(i: SensitiveAccessInput): boolean {
  if (!i.scope || !i.inScope) return false;
  if (i.isManager || i.handlesProject) return true;
  const a = i.accident;
  return a.createdBy === i.userId || a.reportedBy === i.userId || a.assignedTo === i.userId || i.previousHandlers.includes(i.userId);
}

/** Legacy categories whose files project managers always saw as the case handlers (no new grant needed). */
const LEGACY_SENSITIVE: ReadonlySet<string> = new Set(["POLICE_REPORT", "INSURANCE"]);

/**
 * Who sees a file of an accident the caller can already read.
 *  - non-sensitive categories: everyone who reads the case;
 *  - the uploader always sees their own upload (a driver sees what they filed, nothing of others);
 *  - the handler of the case (accidents.update reaching it) keeps the legacy police/insurance files;
 *  - otherwise the sensitive-document rule (permission + scope + participant).
 */
export function canViewAttachment(category: string, access: SensitiveAccessInput, uploadedBy?: string | null): boolean {
  if (!isSensitiveCategory(category)) return true;
  if (uploadedBy && uploadedBy === access.userId) return true;
  if (LEGACY_SENSITIVE.has(category) && access.handlesProject) return true;
  return canViewSensitiveDocument(access);
}

const CLAIM_CATEGORIES: ReadonlySet<string> = new Set(["CLAIM_FORM", "INSURER_DECISION", "COMPENSATION_PROOF"]);
const INSURANCE_STAGES: ReadonlySet<string> = new Set(["AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF"]);

export type UploadInput = {
  category: string;
  stage: string;
  /** The user created the case and holds accidents.create. */
  isCreator: boolean;
  /** accidents.update reaching the case. */
  handlesProject: boolean;
  /** review.technical and the case is theirs (assigned) or they hold accidents.assign. */
  isTechnicalActor: boolean;
  /** claims.manage and the case is theirs (assigned) or they hold accidents.assign. */
  isClaimsActor: boolean;
};

/** Who may add a file of this category at this stage. A closed case takes no files. */
export function canUploadAttachment(i: UploadInput): boolean {
  if (i.stage === "CLOSED") return false;
  if (CLAIM_CATEGORIES.has(i.category)) return i.isClaimsActor && INSURANCE_STAGES.has(i.stage);
  if (i.category === "ESTIMATE") return i.handlesProject && i.stage === "AWAITING_ESTIMATES";
  if (i.stage === "AWAITING_TECHNICAL" && i.isTechnicalActor && (i.category === "PHOTO" || i.category === "OTHER")) return true;
  if (i.stage === "DRAFT") return i.isCreator || i.handlesProject;
  return i.handlesProject;
}

/** The four required documents are replaced (the old file is kept, marked superseded); other categories accumulate. */
export const SINGLE_DOCUMENT_CATEGORIES: ReadonlySet<string> = new Set(REQUIRED_FOR_SUBMIT);

/** Re-uploading a category supersedes the current file instead of deleting it. */
export function pickSuperseded<T extends { id: string; category: string; supersededAt: Date | null }>(existing: T[], category: string): T[] {
  return existing.filter((a) => a.category === category && a.supersededAt === null);
}
