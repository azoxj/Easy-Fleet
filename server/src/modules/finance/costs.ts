import { sql, type SQL } from "drizzle-orm";
import type { Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";

/**
 * Unified cost ledger (read model) built from the operational tables — the
 * single definition used by the finance dashboard, project financials and
 * reports, so every screen shows the same numbers:
 *   FUEL         fuel_transactions.total                       (fueled_at)
 *   MAINTENANCE  parts + labor of CLOSED maintenance requests   (closed_at)
 *   INSURANCE    insurance_policies.premium_amount              (issue_date, else created_at)
 *   REGISTRATION vehicle_documents.fee (REGISTRATION)           (issue_date, else created_at)
 *   ACCIDENT     accidents.repair_cost                          (occurred_at)
 *   VIOLATION    violations.amount of PAID violations           (payment_date)
 *   <category>   APPROVED manual expenses                       (expense_date)
 */
export function costsCte(orgId: string, tz: string): SQL {
  return sql`costs as (
    select f.project_id, f.vehicle_id, (f.fueled_at at time zone ${tz})::date as day, 'FUEL'::text as category, f.total::numeric as amount
      from fuel_transactions f where f.organization_id = ${orgId}
    union all
    select mr.project_id, mr.vehicle_id, (mr.closed_at at time zone ${tz})::date, 'MAINTENANCE',
           coalesce((select sum(p.total) from maintenance_parts p where p.maintenance_request_id = mr.id), 0)
         + coalesce((select sum(l.total) from maintenance_labor l where l.maintenance_request_id = mr.id), 0)
      from maintenance_requests mr where mr.organization_id = ${orgId} and mr.status = 'CLOSED' and mr.closed_at is not null
    union all
    select v.project_id, v.id, coalesce(ip.issue_date, (ip.created_at at time zone ${tz})::date), 'INSURANCE', ip.premium_amount
      from insurance_policies ip join vehicles v on v.id = ip.vehicle_id
     where ip.organization_id = ${orgId} and ip.premium_amount is not null
    union all
    select v.project_id, v.id, coalesce(vd.issue_date, (vd.created_at at time zone ${tz})::date), 'REGISTRATION', vd.fee
      from vehicle_documents vd join vehicles v on v.id = vd.vehicle_id
     where vd.organization_id = ${orgId} and vd.document_type = 'REGISTRATION' and vd.fee is not null and vd.deleted_at is null
    union all
    select a.project_id, a.vehicle_id, (a.occurred_at at time zone ${tz})::date, 'ACCIDENT', a.repair_cost
      from accidents a where a.organization_id = ${orgId} and a.repair_cost is not null
    union all
    select vi.project_id, vi.vehicle_id, vi.payment_date, 'VIOLATION', vi.amount
      from violations vi where vi.organization_id = ${orgId} and vi.status = 'PAID' and vi.payment_date is not null
    union all
    select e.project_id, e.vehicle_id, e.expense_date, e.category::text, e.amount
      from expenses e where e.organization_id = ${orgId} and e.status = 'APPROVED'
  )`;
}

/**
 * Project filter for the ledger according to the caller's scope for `perm`:
 * ALL → everything; PROJECT → member projects; ASSIGNED → nothing aggregated
 * (users with ASSIGNED finance scope only see their own expense records).
 */
export function costsScope(a: Access, perm: PermissionKey = "finance.read"): SQL {
  const s = a.scopeOf(perm);
  if (s === "ALL") return sql`true`;
  if (s === "PROJECT" && a.memberProjectIds.length) {
    return sql`project_id = any(array[${sql.join(a.memberProjectIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])`;
  }
  return sql`false`;
}

export const COST_CATEGORIES = ["FUEL", "MAINTENANCE", "INSURANCE", "REGISTRATION", "ACCIDENT", "VIOLATION", "OTHER"] as const;
