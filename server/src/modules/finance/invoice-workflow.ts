import type { PermissionKey } from "../../auth/permissions.js";
import type { AuditAction } from "../../services/audit.js";

/**
 * Invoice state machine — the only definition of allowed transitions.
 * DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → TRANSFER_PENDING (automatic)
 *   → TRANSFERRED (transfer + receipt) → PAID
 * SUBMITTED | UNDER_REVIEW → REJECTED (reason) → (edit) → SUBMITTED
 * DRAFT | SUBMITTED | REJECTED → CANCELLED
 */
export type InvoiceStatus = "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "TRANSFER_PENDING" | "TRANSFERRED" | "PAID" | "CANCELLED";
export type InvoiceAction = "submit" | "startReview" | "approve" | "reject" | "cancel" | "transfer" | "markPaid";

export const INVOICE_ACTIONS: Record<InvoiceAction, { from: InvoiceStatus[]; to: InvoiceStatus; perm: PermissionKey; audit: AuditAction; creatorOnly?: boolean; notCreator?: boolean; reason?: boolean }> = {
  submit: { from: ["DRAFT", "REJECTED"], to: "SUBMITTED", perm: "invoices.create", audit: "INVOICE_SUBMITTED", creatorOnly: true },
  startReview: { from: ["SUBMITTED"], to: "UNDER_REVIEW", perm: "invoices.approve", audit: "INVOICE_REVIEW_STARTED", notCreator: true },
  approve: { from: ["SUBMITTED", "UNDER_REVIEW"], to: "APPROVED", perm: "invoices.approve", audit: "INVOICE_APPROVED", notCreator: true },
  reject: { from: ["SUBMITTED", "UNDER_REVIEW"], to: "REJECTED", perm: "invoices.reject", audit: "INVOICE_REJECTED", notCreator: true, reason: true },
  cancel: { from: ["DRAFT", "SUBMITTED", "REJECTED"], to: "CANCELLED", perm: "invoices.create", audit: "INVOICE_CANCELLED", creatorOnly: true },
  transfer: { from: ["TRANSFER_PENDING"], to: "TRANSFERRED", perm: "finance.transfer", audit: "INVOICE_TRANSFERRED" },
  markPaid: { from: ["TRANSFERRED"], to: "PAID", perm: "finance.transfer", audit: "INVOICE_PAID" },
};

export const EDITABLE: InvoiceStatus[] = ["DRAFT", "REJECTED"];
export const OPEN_FOR_FINANCE: InvoiceStatus[] = ["SUBMITTED", "UNDER_REVIEW"];
