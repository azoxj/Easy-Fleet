import type { Request } from "express";
import type { Access } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { unauthorized } from "./errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionUser;
      access?: Access;
    }
  }
}

/** Returns the authenticated session + access context or throws 401. */
export function ctx(req: Request): { user: SessionUser; access: Access } {
  if (!req.session || !req.access) throw unauthorized();
  return { user: req.session, access: req.access };
}

export function clientInfo(req: Request) {
  return { ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 512) };
}
