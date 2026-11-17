# Accident documents

Every accident (legacy accidents and workflow cases alike) shows its documents in one panel
(`web/src/pages/operations/accidents/DocumentsPanel.tsx`).

## Core documents
Four independent documents, each with its own row, status and file:

| Category | Arabic label |
|---|---|
| `NAJM_REPORT` | تقرير نجم / المرور |
| `DRIVER_ID` | هوية السائق / الإقامة |
| `DRIVER_LICENSE` | رخصة القيادة |
| `VEHICLE_REGISTRATION` | استمارة المركبة |

- **Status:** `MISSING` (not uploaded) or `UPLOADED`. The server computes it (`documentSlots` in `GET /api/accidents/:id` and
  `GET /api/accident-cases/:id`) from the files the caller may see; a file the caller may not see is not mentioned at all.
- **Replace:** uploading a core document again makes the new file current and marks the old one superseded
  (`superseded_at`). Nothing is deleted; the history is shown under the row. Two people replacing at once are serialised
  by a row lock, so there is always exactly one current file.
- **Upload:** `POST /api/accidents/:id/attachments?category=…` (legacy) and `POST /api/accident-cases/:id/attachments?category=…`
  (workflow). Legacy accidents now accept the four core categories as well as the older ones (`PHOTO`, `POLICE_REPORT`,
  `INSURANCE`, `REPAIR_INVOICE`, `OTHER`, which keep accumulating). Permissions, project scope, the closed-accident rule and the
  workflow rules are unchanged.
- **View / download:** `GET …/file` downloads; `GET …/file?view=inline` shows a PDF or an image in the browser (audited as a
  download). The screen previews images in a dialog and opens PDFs in a new tab. Other types are only downloaded.
- **Audit:** the upload event of a core document records the category, the attachment id and whether it replaced a file,
  never the file name.

No database migration is needed: `accident_attachments.superseded_at` already exists.
