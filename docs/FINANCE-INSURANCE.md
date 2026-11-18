# Finance and insurance workspaces

## Roles
- **FINANCE** and **FINANCE_OFFICER** (same grants; the older key is kept for existing users): every permission is `PROJECT` scope = the projects the user is linked to. Several officers may share a project; one officer may hold several. `accidents.read` is `ASSIGNED` plus the finance window (cases forwarded to finance, or reviewed by the user).
- **INSURANCE_OFFICER**: central account. `insurance.read/create/update`, `projects.read`, `vehicles.read`, `reports.read/export` at `ALL`; `accidents.claims.manage` `ALL`; sees every case with insurance (stage or claim) in any project (`insuranceWindow`). No finance, closing or reopening rights; the money is confirmed by finance, closing by SUPER_ADMIN.
- Linking users to projects: project page → members (existing) or Users → «المشاريع» (`GET/PUT /api/users/:id/projects`, audited).

## Finance menu
Dashboard (overview: total claims, due, overdue, paid, insurance approved/awaiting/collected, waiting for me, per project) · claims & dues · invoices · expenses · transfers & proofs (`/api/finance/transfers`) · accidents & insurance claims (`/api/finance/accident-finance`) · maintenance/fuel/violation costs (original screens) · finance reports (CSV export).
No double counting: the invoice, the transfer and the expense are each read from their original record; a finance-confirmed accident repair invoice replaces the estimate as `accidents.repair_cost`, so the cost ledger counts it once. Separation of duties stays as before: creator ≠ reviewer/approver, transfer and mark-paid are separate permissions, every action is audited with its actor.

## Insurance menu
Dashboard · policies (expiry, renewal alerts; `/api/insurance-center/policies`) · accidents & claims · compensation (approved / awaiting transfer / at finance / collected) · documents & gaps · reports (policies, claims). Filters by project, vehicle and status.

No migration is needed for this change (grants are synced by the normal bootstrap).
