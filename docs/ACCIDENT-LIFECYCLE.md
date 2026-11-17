# Accident report lifecycle and roles

Stages: DRAFT → AWAITING_TECHNICAL → AWAITING_ESTIMATES → AWAITING_TECHNICAL_DECISION → (repair) REPAIR_IN_PROGRESS → AWAITING_FINANCE_REVIEW → AWAITING_TECHNICAL_FINAL → AWAITING_FINAL_CLOSURE → CLOSED
or (insurance) AWAITING_INSURANCE → CLAIM_IN_PROGRESS → AWAITING_COMPENSATION_PROOF → AWAITING_FINANCE_REVIEW → …

- A rejected claim returns to AWAITING_TECHNICAL_DECISION (re-file or repair).
- Send-back (reason required): technician → project manager (DRAFT); finance → repair / claim.
- Only SUPER_ADMIN holds `accidents.close` / `accidents.reopen` and edits basic data after submission (audited).
- INSURANCE_OFFICER: `accidents.read` ASSIGNED, `claims.manage`; no finance powers. FINANCE_OFFICER: `finance.review` + `compensation.confirm` at PROJECT scope, sees only cases at the finance stage (or reviewed by them).
- The transfer cannot be confirmed without an uploaded COMPENSATION_PROOF; the repair invoice needs REPAIR_INVOICE.
- Role boards: `GET /api/accident-cases/board` (lanes per duty; never widens visibility).

## Migration 0013 (additive, staging/production-safe)
Two enum values (`AWAITING_FINANCE_REVIEW`, `AWAITING_TECHNICAL_FINAL`) and one table (`accident_finance_reviews`). Nothing is dropped or rewritten; legacy accidents (workflow_stage NULL) are untouched. Role grants sync through the normal bootstrap (`db:setup`).
