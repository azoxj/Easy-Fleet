import path from "node:path";
import express, { Router, type RequestHandler } from "express";
import { readinessChecks } from "./http/readiness.js";
import { resolveWebDist } from "./http/web-dist.js";
import { config } from "./config.js";
import { errorHandler, notFound } from "./http/errors.js";
import { loadSession, noStore, originCheck, rateLimit, requireAuth, securityHeaders } from "./http/middleware.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { approvalsRouter } from "./modules/approvals/routes.js";
import { assignmentsRouter } from "./modules/assignments/routes.js";
import { auditRouter } from "./modules/audit/routes.js";
import { authRouter } from "./modules/auth/routes.js";
import { dashboardRouter } from "./modules/dashboard/routes.js";
import { documentsRouter } from "./modules/documents/routes.js";
import { driversRouter } from "./modules/drivers/routes.js";
import { employeesRouter } from "./modules/employees/routes.js";
import { expensesRouter } from "./modules/finance/expenses.js";
import { invoicesRouter } from "./modules/finance/invoices.js";
import { financeRouter } from "./modules/finance/summary.js";
import { accidentsRouter } from "./modules/operations/accidents.js";
import { employeeDocumentsRouter } from "./modules/operations/employee-documents.js";
import { fuelRouter } from "./modules/operations/fuel.js";
import { handoverRouter, publicHandoverRouter } from "./modules/operations/handover.js";
import { qrRouter } from "./modules/operations/qr.js";
import { trackingRouter } from "./modules/operations/tracking.js";
import { violationsRouter } from "./modules/operations/violations.js";
import { costsRouter } from "./modules/maintenance/costs.js";
import { quotesRouter } from "./modules/maintenance/quotes.js";
import { maintenanceRouter } from "./modules/maintenance/routes.js";
import { vendorsRouter } from "./modules/vendors/routes.js";
import { notificationsRouter } from "./modules/notifications/routes.js";
import { projectsRouter } from "./modules/projects/routes.js";
import { rolesRouter } from "./modules/roles/routes.js";
import { reportsRouter } from "./modules/reports/routes.js";
import { searchRouter } from "./modules/search/routes.js";
import { settingsRouter } from "./modules/settings/routes.js";
import { usersRouter } from "./modules/users/routes.js";
import { vehiclesRouter } from "./modules/vehicles/routes.js";

export const apiLimiter = new RateLimiter(600, 60_000);

export function createApp(opts: { webDistDir?: string } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(securityHeaders);

  const api = Router();
  api.use(noStore);
  api.use(rateLimit(apiLimiter));
  api.use(express.json({ limit: "100kb" }));
  api.use(originCheck);
  api.use(loadSession);

  // Liveness: process is up. Never touches the DB and exposes nothing.
  const live: RequestHandler = (_req, res) => {
    res.json({ status: "ok" });
  };
  api.get("/health", live);
  api.get("/healthz", live);
  // Readiness: database reachable and private storage writable (no details leaked).
  api.get("/readyz", async (_req, res) => {
    const checks = await readinessChecks();
    const ok = checks.database && checks.storage;
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable", checks });
  });
  api.use("/auth", authRouter);
  // Token-based vehicle handover link (no session; token + per-IP limits).
  api.use("/public", publicHandoverRouter);

  // Everything below requires an authenticated session (+ CSRF token on writes).
  api.use(requireAuth);
  api.use("/dashboard", dashboardRouter);
  api.use("/users", usersRouter);
  api.use("/roles", rolesRouter);
  api.use("/projects", projectsRouter);
  api.use("/vehicles", vehiclesRouter);
  api.use("/assignments", assignmentsRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/audit-logs", auditRouter);
  api.use("/search", searchRouter);
  api.use("/employees", employeesRouter);
  api.use("/drivers", driversRouter);
  // Vehicle documents, registration, insurance and their files (paths under /vehicles/:id/... and /vehicle-documents, /insurance).
  api.use(documentsRouter);
  api.use("/vendors", vendorsRouter);
  // Maintenance workflow: /maintenance, /maintenance-quotes, /maintenance-parts, /maintenance-labor, /maintenance-attachments, /vehicles/:id/maintenance
  api.use(maintenanceRouter);
  api.use(quotesRouter);
  api.use(costsRouter);
  // Finance: /invoices, /expenses, /finance/dashboard, /projects/:id/financials
  api.use(invoicesRouter);
  api.use(expensesRouter);
  api.use(financeRouter);
  // Operations: /fuel, /accidents, /violations, /employees/:id/documents, /documents-center, /handovers, QR, GPS + map
  api.use(fuelRouter);
  api.use(accidentsRouter);
  api.use(violationsRouter);
  api.use(employeeDocumentsRouter);
  api.use(handoverRouter);
  api.use(qrRouter);
  api.use(trackingRouter);
  // Cross-cutting: /approvals, /reports, /settings
  api.use(approvalsRouter);
  api.use(reportsRouter);
  api.use(settingsRouter);
  api.use((_req, _res, next) => next(notFound("المسار غير موجود")));
  api.use(errorHandler);

  app.use("/api", api);

  // Serve the built SPA from the same origin (keeps SameSite=Strict cookies simple).
  const web = resolveWebDist(opts.webDistDir ?? config.WEB_DIST_DIR, config.NODE_ENV === "production");
  if (web.dir) {
    const dist = web.dir;
    app.use(
      express.static(dist, {
        index: false,
        maxAge: "1h",
        setHeaders: (res, file) => {
          // Hashed assets can be cached long; the shell and the service worker must revalidate.
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          else if (/(sw\.js|\.html|\.webmanifest)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    // SPA fallback for client-side routes (GET / included). /api and /api/* are never touched.
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(dist, "index.html"));
    });
  } else if (config.NODE_ENV === "production") {
    console.error(`[easy-fleet] web build not found (looked for index.html in: ${web.tried.join(", ") || "—"}). Run "npm run build" or set WEB_DIST_DIR.`);
  }
  app.use(errorHandler);
  return app;
}
