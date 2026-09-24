import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Response } from "express";
import { config } from "../config.js";
import type { DbOrTx } from "../db/client.js";
import { organizations, sessions, users } from "../db/schema/index.js";

/** `__Host-` prefix pins the cookie to this exact origin (requires Secure). */
export const SESSION_COOKIE = config.COOKIE_SECURE ? "__Host-ef_session" : "ef_session";

const IDLE_MS = config.SESSION_IDLE_MINUTES * 60_000;
const ABSOLUTE_MS = config.SESSION_ABSOLUTE_HOURS * 3_600_000;
const TOUCH_INTERVAL_MS = 60_000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function createSession(db: DbOrTx, userId: string, ip: string | undefined, userAgent: string | undefined) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      csrfToken,
      ip: ip ?? null,
      userAgent: userAgent?.slice(0, 512) ?? null,
      expiresAt: new Date(now + ABSOLUTE_MS),
    })
    .returning({ id: sessions.id });
  return { token, csrfToken, sessionId: row!.id };
}

export type SessionUser = {
  sessionId: string;
  csrfToken: string;
  userId: string;
  orgId: string;
  email: string;
  name: string;
  mustChangePassword: boolean;
};

/** Resolves a raw cookie token into an active session + active user, or null. */
export async function resolveSession(db: DbOrTx, token: string): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      orgId: users.organizationId,
      email: users.email,
      name: users.name,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        eq(users.status, "ACTIVE"),
        eq(organizations.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.lastSeenAt.getTime() + IDLE_MS <= now) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, row.sessionId));
    return null;
  }
  if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }
  const { lastSeenAt: _l, expiresAt: _e, ...user } = row;
  return user;
}

export async function revokeSession(db: DbOrTx, sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeAllUserSessions(db: DbOrTx, userId: string, exceptSessionId?: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : sql`true`,
      ),
    );
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
    maxAge: ABSOLUTE_MS,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "strict", path: "/" });
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
