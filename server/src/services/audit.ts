import type { Request } from "express";
import type { DbOrTx } from "../db/client.js";
import { auditLogs } from "../db/schema/index.js";

export type AuditAction =
  | "AUTH_LOGIN"
  | "AUTH_LOGIN_FAILED"
  | "AUTH_LOGOUT"
  | "AUTH_PASSWORD_CHANGED"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_ROLES_CHANGED"
  | "USER_DISABLED"
  | "USER_ENABLED"
  | "USER_PASSWORD_RESET"
  | "PROJECT_CREATED"
  | "PROJECT_UPDATED"
  | "PROJECT_MEMBER_ADDED"
  | "PROJECT_MEMBER_REMOVED"
  | "VEHICLE_CREATED"
  | "VEHICLE_UPDATED"
  | "VEHICLE_ARCHIVED"
  | "ASSIGNMENT_CREATED"
  | "ASSIGNMENT_STATUS_CHANGED"
  | "EMPLOYEE_CREATED"
  | "EMPLOYEE_UPDATED"
  | "EMPLOYEE_ARCHIVED"
  | "DRIVER_CREATED"
  | "DRIVER_UPDATED"
  | "DRIVER_ARCHIVED"
  | "VEHICLE_DRIVER_CHANGED"
  | "VEHICLE_DOCUMENT_ADDED"
  | "VEHICLE_DOCUMENT_UPDATED"
  | "VEHICLE_DOCUMENT_DELETED"
  | "REGISTRATION_ADDED"
  | "REGISTRATION_UPDATED"
  | "INSURANCE_ADDED"
  | "INSURANCE_UPDATED"
  | "FILE_UPLOADED"
  | "FILE_DOWNLOADED"
  | "VENDOR_CREATED"
  | "MAINTENANCE_CREATED"
  | "MAINTENANCE_UPDATED"
  | "MAINTENANCE_ASSIGNED"
  | "MAINTENANCE_INSPECTION_STARTED"
  | "MAINTENANCE_INSPECTION_COMPLETED"
  | "MAINTENANCE_APPROVED"
  | "MAINTENANCE_REJECTED"
  | "MAINTENANCE_REPAIR_STARTED"
  | "MAINTENANCE_READY_FOR_HANDOVER"
  | "MAINTENANCE_HANDOVER_ACCEPTED"
  | "MAINTENANCE_HANDOVER_REJECTED"
  | "MAINTENANCE_CLOSED"
  | "MAINTENANCE_STATUS_CHANGED"
  | "QUOTE_CREATED"
  | "QUOTE_UPDATED"
  | "QUOTE_SUBMITTED"
  | "QUOTE_REVIEW_STARTED"
  | "QUOTE_APPROVED"
  | "QUOTE_REJECTED"
  | "PART_ADDED"
  | "PART_UPDATED"
  | "PART_REMOVED"
  | "LABOR_ADDED"
  | "LABOR_UPDATED"
  | "LABOR_REMOVED"
  | "PROJECT_ARCHIVED"
  | "USER_DELETED"
  | "VENDOR_UPDATED"
  | "INVOICE_CREATED"
  | "INVOICE_UPDATED"
  | "INVOICE_SUBMITTED"
  | "INVOICE_REVIEW_STARTED"
  | "INVOICE_APPROVED"
  | "INVOICE_REJECTED"
  | "INVOICE_CANCELLED"
  | "INVOICE_TRANSFERRED"
  | "INVOICE_PAID"
  | "INVOICE_STATUS_CHANGED"
  | "EXPENSE_CREATED"
  | "EXPENSE_APPROVED"
  | "EXPENSE_REJECTED"
  | "FUEL_CREATED"
  | "ACCIDENT_CREATED"
  | "ACCIDENT_UPDATED"
  | "ACCIDENT_STATUS_CHANGED"
  | "VIOLATION_CREATED"
  | "VIOLATION_UPDATED"
  | "VIOLATION_STATUS_CHANGED"
  | "EMPLOYEE_DOCUMENT_ADDED"
  | "EMPLOYEE_DOCUMENT_UPDATED"
  | "EMPLOYEE_DOCUMENT_DELETED"
  | "HANDOVER_CREATED"
  | "HANDOVER_LINK_ROTATED"
  | "HANDOVER_PHOTO_UPLOADED"
  | "HANDOVER_COMPLETED"
  | "HANDOVER_RETURN_COMPLETED"
  | "HANDOVER_CLOSED"
  | "HANDOVER_CANCELLED"
  | "HANDOVER_TOKEN_INVALID"
  | "TRIP_STARTED"
  | "TRIP_ENDED"
  | "ASSIGNMENT_UPDATED"
  | "NOTIFICATION_BROADCAST"
  | "SETTINGS_UPDATED"
  | "REPORT_EXPORTED"
  | "SECURITY_CSRF_REJECTED"
  | "SECURITY_RATE_LIMITED";

export type AuditEntry = {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  projectId?: string | null;
  /** Vehicle the event belongs to; drives the vehicle timeline. */
  vehicleId?: string | null;
  metadata?: Record<string, unknown>;
  /** Explicit before/after snapshots; derived from metadata.changes when omitted. */
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  /** Overrides the actor derived from the request (e.g. failed logins). */
  userId?: string | null;
  orgId?: string | null;
};

/** Keys that must never be written to the audit trail. */
const REDACT = /password|token|secret|hash|iban|national/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? "[REDACTED]" : redact(v, depth + 1)]),
  );
}

/**
 * Writes an audit record. Pass the transaction handle when the audited change
 * happens inside a transaction so both commit (or roll back) together.
 */
export async function audit(db: DbOrTx, req: Request | null, entry: AuditEntry): Promise<void> {
  let oldValue = entry.oldValue ?? null;
  let newValue = entry.newValue ?? null;
  const changes = entry.metadata?.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (!oldValue && !newValue && changes && typeof changes === "object") {
    oldValue = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v?.from ?? null]));
    newValue = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v?.to ?? null]));
  } else if (!oldValue && !newValue && entry.metadata && ("fromStatus" in entry.metadata || "toStatus" in entry.metadata)) {
    oldValue = { status: entry.metadata.fromStatus ?? null };
    newValue = { status: entry.metadata.toStatus ?? null };
  }
  await db.insert(auditLogs).values({
    oldValue: oldValue ? (redact(oldValue) as Record<string, unknown>) : null,
    newValue: newValue ? (redact(newValue) as Record<string, unknown>) : null,
    organizationId: entry.orgId !== undefined ? entry.orgId : (req?.session?.orgId ?? null),
    userId: entry.userId !== undefined ? entry.userId : (req?.session?.userId ?? null),
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    projectId: entry.projectId ?? null,
    vehicleId: entry.vehicleId ?? null,
    metadata: entry.metadata ? (redact(entry.metadata) as Record<string, unknown>) : null,
    ip: req?.ip ?? null,
    userAgent: req?.get("user-agent")?.slice(0, 512) ?? null,
  });
}

/** Field-level diff for update audit entries: { field: { from, to } }. */
export function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, to] of Object.entries(patch)) {
    if (to === undefined) continue;
    const from = before[k];
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    if (norm(from) !== norm(to)) out[k] = { from: norm(from), to: norm(to) };
  }
  return out;
}
