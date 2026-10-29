# Accident workflow — screens (Phase 3)

Development only: nothing committed or deployed. Both switches stay off by default (`ACCIDENT_WORKFLOW_ENABLED`, `ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT`).

## Where it lives
Everything is inside the existing **Accidents** section. The sidebar is unchanged (one "Accidents" entry, "Assignment tracking" untouched);
`web/src/lib/nav-accidents.test.ts` guards that. Routes: `/accidents` (list), `/accidents/new` (report form), `/accidents/:id` (one route for both kinds:
a workflow case opens the case screen when the workflow is on, a legacy accident keeps its own screen, its links and its edit/status actions).
With the workflow off the page is the legacy one (the report button opens the old dialog; `/accidents/new` says it is not available).

## The list (`/accidents`)
- Summary cards: open, closed, overdue (workflow cases), awaiting assignment (only for people who assign). Drafts are never counted as accidents; one line mentions them.
- Tabs (`?view=`), shown by permission and only with the workflow on: all accidents; my reports (`accidents.create`); my assigned tasks (`review.technical` / `claims.manage`);
  awaiting assignment (`accidents.assign`); returned for completion; drafts; insurance claims. The server still decides what each returns (the queue answers 403 to others).
- Rows show the stage, the assignee (or what is due), and the badges: returned for completion, overdue, preliminary report.

## Report form (`/accidents/new`)
Project → vehicle → driver (project-wide users), time, location (+ my location), severity, responsibility, Najm number, description, and the four required documents
(Najm/traffic report, driver ID, licence, vehicle registration) with a "missing" flag each. Save as draft, or submit once complete (project-wide users);
a driver sends a preliminary report that the project manager completes. Files are checked for type/size before sending; the server checks again.

## Case screen (`/accidents/:id`)
Header: number, stage, severity, flags, vehicle, time, and the actions the server offers (`actions`). Sections: information; documents (what the server lets this user see,
required-documents checklist on a draft, upload only for the categories the server offers); technical review (damage, notes, repair / not repairable / no repair needed);
estimates (several, one approved, nothing deleted); insurance claim (register, processing, approve, reject/not covered with reason and document, compensation proof);
status (stage, assignee, next action, stage deadline); actions and assignment log. "Returned for completion" banner: reason, date, who must act, the action, what is missing.
Dialogs: close (lists what is missing, e.g. repair documentation), return, reopen, assign (the server lists who can be chosen), edit draft.
Every button is a request: a 409 `REQUIREMENTS_NOT_MET` shows the server's missing list; nothing is allowed because a button was visible.

## Server additions for the screens
`GET /accidents/features` (workflow on/off), `GET /accidents/stats`, `GET /accidents?view=…` (+ stage, assignee, returned, overdue fields on rows; reading also reaches cases
assigned to the caller), case detail `requirements` / `uploadCategories`, `GET /accident-cases/:id/assignable`.

## Browser tests
`web/e2e/run.sh` (not part of `npm test`): seeds a LOCAL database `ef_e2e` (refuses anything non-local or not named e2e/test), starts the server twice (workflow off, on) and drives
Chromium (Playwright) through the legacy page, the driver's phone form, the project manager's completion, technician, estimates, insurance, closure, return, queue and
assignment, viewer and legacy accident; it also checks the sidebar, mobile overflow and console errors, and writes screenshots.
