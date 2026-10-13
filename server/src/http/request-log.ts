import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { logger, safePath } from "../lib/logger.js";

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
  }
}

const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Request ID (reuses a well-formed X-Request-Id from the proxy, otherwise a new UUID, echoed back in the
 * response) plus one structured line per finished request. The logged path never contains handover tokens and the
 * query string is dropped; headers, cookies and bodies are never logged.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  req.id = incoming && ID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const started = process.hrtime.bigint();
  if (config.LOG_REQUESTS) {
    res.on("finish", () => {
      const path = safePath(req.originalUrl);
      if (res.statusCode < 400 && (path === "/api/healthz" || path === "/api/health")) return; // probes are noise
      const fields = {
        requestId: req.id,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
        ip: req.ip,
        userId: req.session?.userId,
        bytes: Number(res.getHeader("content-length")) || undefined,
      };
      if (res.statusCode >= 500) logger.error("request", fields);
      else if (res.statusCode >= 400) logger.warn("request", fields);
      else logger.info("request", fields);
    });
  }
  next();
};
