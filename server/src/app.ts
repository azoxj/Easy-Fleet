import { existsSync } from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { config } from "./config.js";
import { errorHandler, notFound } from "./http/errors.js";
import { loadSession, noStore, originCheck, rateLimit, requireAuth, securityHeaders } from "./http/middleware.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { assignmentsRouter } from "./modules/assignments/routes.js";
import { auditRouter } from "./modules/audit/routes.js";
import { authRouter } from "./modules/auth/routes.js";
import { dashboardRouter } from "./modules/dashboard/routes.js";
import { notificationsRouter } from "./modules/notifications/routes.js";
import { projectsRouter } from "./modules/projects/routes.js";
import { rolesRouter } from "./modules/roles/routes.js";
import { searchRouter } from "./modules/search/routes.js";
import { usersRouter } from "./modules/users/routes.js";
import { vehiclesRouter } from "./modules/vehicles/routes.js";

export const apiLimiter = new RateLimiter(600, 60_000);

export function createApp() {
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

  api.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  api.use("/auth", authRouter);

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
  api.use((_req, _res, next) => next(notFound("المسار غير موجود")));
  api.use(errorHandler);

  app.use("/api", api);

  // Optional: serve the built SPA from the same origin (keeps SameSite=Strict cookies simple).
  if (config.WEB_DIST_DIR) {
    const dist = path.resolve(config.WEB_DIST_DIR);
    if (existsSync(dist)) {
      app.use(express.static(dist, { index: false, maxAge: "1h" }));
      app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
    }
  }
  app.use(errorHandler);
  return app;
}
