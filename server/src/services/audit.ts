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
  | "ASSIGNMENT_STATUS_CHANGED";

export type AuditEntry = {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
  /** Overrides the actor derived from the request (e.g. failed logins). */
  userId?: string | null;
  orgId?: string | null;
};

/** Keys that must never be written to the audit trail. */
const REDACT = /password|token|secret|hash|iban/i;

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
  await db.insert(auditLogs).values({
    organizationId: entry.orgId !== undefined ? entry.orgId : (req?.session?.orgId ?? null),
    userId: entry.userId !== undefined ? entry.userId : (req?.session?.userId ?? null),
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    projectId: entry.projectId ?? null,
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
