# Interactive lists & motion

## Lists (vehicles, maintenance, invoices, expenses, accidents, violations, fuel, handovers, employees, drivers, projects, vendors, documents)

- **Column sorting** — click a header (↑ → ↓ → default order); on phones a "Sort by / ترتيب حسب" menu. Sorting is done by the server over the whole result set (not just the visible page) through `sort` / `dir` query parameters. Each endpoint whitelists its sortable columns (`sortOrder()` in `server/src/http/validate.ts`); unknown keys are ignored and never interpolated. Maintenance cost is sortable only for users who may see costs. Vendors (not paginated) sort in the browser.
- **State in the URL** — search, filters, page and sort live in the query string (`hooks/useListState.ts`), so a list survives refresh and "back" and can be shared. Lists embedded in another page (vehicle tabs, project page) keep their state in memory instead.
- **Search** waits for a short pause in typing (one request per search, spinner in the box).
- **No flashing** — the first load shows a skeleton; later reloads keep the rows on screen, dimmed under a thin progress bar (`ListBody`).
- **Quick view** — clicking a row opens a side panel (left in Arabic, right in English; bottom sheet on phones) with every column, ↑/↓ (or buttons) to move between records, Esc to close, and "Open full page". The record link in the first column still opens the page directly. Expenses, fuel and vendors keep their own detail/edit dialogs.

## Motion

Page fade-in on navigation, animated dialogs/drawer/toasts, staggered row appearance, counting dashboard numbers, lifting KPI cards, button press feedback, and an animated workflow stepper on maintenance requests and invoices. All of it is disabled when the OS asks for reduced motion (`prefers-reduced-motion`). Dialogs render in a portal on `<body>` so they are always positioned against the viewport.
