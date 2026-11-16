# Accident case workflow — API (Phase 2)

Development only: not committed, not deployed, no migration run outside disposable test databases. No UI yet.

## Two independent switches
1. `ACCIDENT_WORKFLOW_ENABLED` (default off): all routes under `/api/accident-cases` answer `404 NOT_FOUND`, like a route that does not exist, until it is on.
   Turning it on changes nothing for existing accidents or their files.
2. `ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT` (default off): applies the sensitive-document rule to LEGACY accidents (police report, insurance,
   …). It is the only part of this feature that changes what existing users can see (table in `docs/ACCIDENTS-PHASE1.md`), so it is decided and
   enabled on its own, before or after the workflow, with or without it.
Workflow cases are always protected, whatever the second switch says (they exist only after the first was on). Defaults are in `.env.example` and
`deploy/aws/easy-fleet.env.example`.

Rollout order (nothing here has been done): migration 0010 → `npm run db:sync-accident-catalog` (preview, review, then apply with the
plan hash; add `--include-technical` and `--include-project-manager-sensitive` when decided) → designate officers → turn the workflow switch on.
The legacy-file switch is a separate later decision. Rolling back the application after the first workflow case exists: see
`docs/ACCIDENTS-PHASE1.md`.

## Routes
| Method + path | Who | What |
|---|---|---|
| `POST /accident-cases` | `accidents.create` (project manager, driver for own vehicle) | Create a DRAFT. The vehicle is not touched. A driver's draft is a preliminary report (`reportedBy`). |
| `GET /accident-cases` | `accidents.read` | Workflow cases the caller may see. Filters `stage`, `projectId`, `vehicleId`, `mine=true`, `queue=true` (assigners only), `q`. Includes `slaDueAt`/`overdue`. |
| `GET /accident-cases/:id` | `accidents.read` | Detail: stage, attachments the caller may see, estimates, claim, transition log, assignment log, SLA, `actions`. |
| `PATCH /accident-cases/:id` | draft creator, or `accidents.update` reaching the project | Edit a DRAFT. |
| `POST /accident-cases/:id/submit` | `accidents.update` reaching the project | DRAFT → AWAITING_TECHNICAL. The four documents are mandatory (409 `REQUIREMENTS_NOT_MET` + `details.missing`). Vehicle → ACCIDENT; technical officer assigned. |
| `PUT /accident-cases/:id/technical` | `accidents.review.technical`, assignee (or an `accidents.assign` holder) | Damage description, notes and the repair decision `repairDecision`: `REPAIR`, `NOT_REPAIRABLE` or `NOT_NEEDED`. The last two skip the estimates and need the notes (the reason) to leave the stage. |
| `POST /accident-cases/:id/transition` `{to, reason?, resolution?}` | by move | Technical → ESTIMATES (repairable) or INSURANCE (not repairable); ESTIMATES → INSURANCE (`accidents.update`, one estimate chosen); FINAL_CLOSURE → CLOSED (`accidents.close`, resolution + finished claim + repair outcome, see below); return to an earlier stage and reopen a closed case (`accidents.reopen`, reason). Claim stages are entered through the claim routes. |
| `POST /accident-cases/:id/estimates`, `POST …/estimates/:eid/select` | `accidents.update` reaching the project, stage AWAITING_ESTIMATES | Add an estimate (needs an uploaded ESTIMATE file) / choose the one approved estimate. Estimates are never deleted; choosing another un-selects the previous one (a partial unique index allows one). |
| `PUT /accident-cases/:id/claim` | `accidents.claims.manage`, assignee | Register insurer, claim number, date (and amount); AWAITING_INSURANCE → CLAIM_IN_PROGRESS. Also edits them later. |
| `POST /accident-cases/:id/claim/status` `{status,…}` | same | PROCESSING; APPROVED (→ AWAITING_COMPENSATION_PROOF); REJECTED / not covered (reason + INSURER_DECISION file → AWAITING_FINAL_CLOSURE); COMPENSATION_RECEIVED (amount + COMPENSATION_PROOF file → AWAITING_FINAL_CLOSURE). |
| `POST /accident-cases/:id/assign` `{userId, reason?}` | `accidents.assign` | Assign or reassign (the user must hold the stage permission). Logged. |
| `GET/POST /accident-cases/officers`, `DELETE …/officers/:id` | `accidents.assign` (ALL for organisation-wide, PROJECT for that project) | Designated officers per stage. |
| `GET /accident-cases/settings` | `accidents.assign` or `accidents.settings.manage` | Delay limits (calendar days) and `canEdit`. |
| `PUT /accident-cases/settings` | `accidents.settings.manage` with scope ALL (or the general `settings.manage` ALL) | Changes the four delay limits (1–90 days, strict body). `accidents.assign` alone — even with ALL — is refused (403). Audited as `ACCIDENT_CASE_SETTINGS` with the before/after of each limit. |
| `POST /accident-cases/:id/attachments?category=` | by category and stage (see below) | Upload. The four required documents are replaced (old file kept, marked superseded). |
| `GET /accident-cases/:id/attachments/:attId/file` | whoever may see that file | Download. |

## Returned for completion
A return (to an earlier stage) or a reopen keeps the case in the stage it was sent to and shows a marker: `returnedForCompletion` in the detail
`{stage, reason, returnedAt, returnedBy, requiredAction}` and a flag on every list row (`?returned=true` filters). `requiredAction` says who must act:
`USER` (the assignee), `QUEUE` (nobody assigned: the assigners), `PROJECT_MANAGER` (estimates stage: the project's manager) or `ROLE` (closure: the
`accidents.close` holders), always with the permission. Whoever must act is notified (`ACCIDENT_CASE_RETURNED`, link `/accidents/:id`). The
marker goes away with the next forward move; the transition log (with the reason) and everything else is never rewritten.

## Final closure
A finished claim is not enough. To close, all of: a resolution text; the claim finished (rejected / compensation received); and the repair
outcome — `REPAIR` needs a repair document (`REPAIR_INVOICE` or `REPAIR_COMPLETION`, filed by the project's handler); `NOT_REPAIRABLE` and
`NOT_NEEDED` need the technician's explained decision (damage description and notes). A missing outcome blocks closure. The answer lists
what is missing (`details.missing`: `repair.decision`, `repair.documentation`, `technical.notes`, `resolution`, `claim.terminal`).

## Assignment
Entering AWAITING_TECHNICAL or AWAITING_INSURANCE runs the engine: exactly one eligible designated officer (project level first, then
organisation-wide; active user who still holds the permission) → assigned automatically; none or several → queue (`assignmentMode=QUEUE`,
assigners are notified; they see it with `?queue=true`). Nothing is random. Every assignment, queueing and reassignment is in
`accident_assignments`; every stage move in `accident_transitions`; both also in the audit trail.

## Documents
Sensitive categories: `DRIVER_ID, DRIVER_LICENSE, VEHICLE_REGISTRATION, CLAIM_FORM, INSURER_DECISION, COMPENSATION_PROOF, POLICE_REPORT, INSURANCE`.
A user sees one when they uploaded it, or hold `accidents.documents.sensitive` reaching the case **and** are a participant (creator,
reporter, current or earlier assignee, a manager with assign/close, or the project's `accidents.update` holder). Project managers
also keep the legacy police/insurance files as case handlers. Everyone who can read the case sees the other categories (photos, Najm report, …).
The same check runs for the case detail, the file download, the legacy `GET /accidents/:id` and `GET /accident-attachments/:id/file`,
and the vehicle timeline. A hidden file is not listed, not counted, not named, and its download answers 404 exactly like a missing file;
audit and timeline events of hidden files are dropped, file names are never written to the audit trail of workflow uploads.
For legacy accidents this enforcement applies only while the switch is on.

Who uploads what: draft — its creator or the project's handler; later stages — the handler; the assigned technician may add photos; ESTIMATE only in the
estimates stage by the handler; CLAIM_FORM / INSURER_DECISION / COMPENSATION_PROOF only by the claims officer in the insurance stages; nothing once closed.

## Preliminary reports and drafts
A driver's report is a draft with `preliminary: true`; the project's `accidents.update` holders (manager or member of that project) are notified,
find it with `?stage=DRAFT`, complete it and submit it. Managers of other projects get 404 on everything about it, see no list entry, no legacy
view, no timeline event and no notification.

## Drafts
A draft is visible only to its creator and reporter, the project's `accidents.update` holders and the `accidents.assign`/`accidents.close` holders.
For everyone else it does not exist (404; absent from lists, the legacy list and detail, and the vehicle timeline). Drafts are excluded from every
statistic, report and cost.

## Putting the project manager's document permission in place
`accidents.documents.sensitive` for PROJECT_MANAGER (PROJECT scope) lets the manager see the identity/licence/registration files a driver filed in
their project. In an existing database it is added only by the targeted tool, on request and nothing else:
`npm run db:sync-accident-catalog -w server -- --include-project-manager-sensitive` (preview; apply with the plan hash and
`EF_CONFIRM_ACCIDENT_CATALOG=yes`). It adds that one row; every other PROJECT_MANAGER grant, including the pending differences from the code, stays as it
is, and the general bootstrap is not involved.

## Where it lives in the application
The workflow belongs inside the existing **Accidents** section (`/accidents`, `/accidents/:id`, permission `accidents.read`): tabs or filters
for all / my tasks (`mine=true`) / queue (`queue=true`, assigners) / returned (`returned=true`) / drafts (`stage=DRAFT`), and actions inside
the detail page driven by `actions`. No new sidebar entries, and **"Assignment tracking" (`/assignments`, `assignments.*`) is not used or duplicated**:
accident assignment is part of the case. The two new roles hold no `assignments.*` permission, so they never see that entry. Notification links already
point at `/accidents/:id`. `web/src/lib/nav-accidents.test.ts` fails if a second accidents entry, a duplicate label or a second assignments entry is added.

## Not in this phase
UI; settings screen/API for the SLA days (`accident_settings` is read, defaults 3/5/7/3 calendar days); the RETURNED stage (a return moves the case
directly to the earlier stage with the reason recorded and the marker above; the state machine still knows RETURNED/resume); the actual grant of `accidents.documents.sensitive` to PROJECT_MANAGER in an existing database (the tool is ready, the decision and the run are not).
