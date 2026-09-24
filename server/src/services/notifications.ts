import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import {
  notificationPreferences,
  notifications,
  permissions,
  projects,
  projectUsers,
  rolePermissions,
  userRoles,
  users,
} from "../db/schema/index.js";

export type NotificationCategory = "MAINTENANCE" | "FINANCE" | "ASSIGNMENT" | "DOCUMENT_EXPIRY" | "ACCIDENT" | "VIOLATION" | "HANDOVER" | "SYSTEM";

/** Maps a notification type to its category (used for filtering and user preferences). */
export function categoryOf(type: string): NotificationCategory {
  if (type.startsWith("MAINTENANCE")) return "MAINTENANCE";
  if (/^(INVOICE|EXPENSE|FINANCE)/.test(type)) return "FINANCE";
  if (/^(ASSIGNMENT|PROJECT_MEMBER|PROJECT_MANAGER)/.test(type)) return "ASSIGNMENT";
  if (/(EXPIRY|EXPIRING|EXPIRED)/.test(type)) return "DOCUMENT_EXPIRY";
  if (type.startsWith("ACCIDENT")) return "ACCIDENT";
  if (type.startsWith("VIOLATION")) return "VIOLATION";
  if (/^(HANDOVER|VEHICLE_DRIVER)/.test(type)) return "HANDOVER";
  return "SYSTEM";
}

export type NotificationInput = {
  orgId: string;
  userIds: string[];
  type: string;
  title: string;
  body?: string;
  /** In-app path, e.g. /vehicles/<id>. External URLs are rejected. */
  link?: string;
  entityType?: string;
  entityId?: string;
  /**
   * When set, recipients who cannot see this project are dropped. This is the
   * guard against cross-project notification leakage.
   */
  projectId?: string | null;
  /** Suppresses duplicates for the same user (e.g. daily expiry scans). */
  dedupeKey?: string;
  category?: NotificationCategory;
};

export function isSafeInternalLink(link: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/.test(link) && !link.includes("\\");
}

/**
 * Creates notifications for recipients that are (a) active users in the same
 * organization and (b) when projectId is given, able to see that project
 * (member / manager, or holding projects.read with ALL scope).
 * Returns the ids of users actually notified.
 */
export async function notifyUsers(db: DbOrTx, input: NotificationInput): Promise<string[]> {
  const unique = [...new Set(input.userIds)];
  if (unique.length === 0) return [];
  if (input.link && !isSafeInternalLink(input.link)) throw new Error("Unsafe notification link");

  const conditions = [
    inArray(users.id, unique),
    eq(users.organizationId, input.orgId),
    eq(users.status, "ACTIVE"),
  ];
  if (input.projectId) {
    const pid = input.projectId;
    conditions.push(sql`(
      exists (select 1 from ${projectUsers} pu where pu.project_id = ${pid} and pu.user_id = ${users.id})
      or exists (select 1 from ${projects} p where p.id = ${pid} and p.manager_id = ${users.id})
      or exists (
        select 1 from ${userRoles} ur
          join ${rolePermissions} rp on rp.role_id = ur.role_id
          join ${permissions} pm on pm.id = rp.permission_id
         where ur.user_id = ${users.id} and pm.key = 'projects.read' and rp.scope = 'ALL'
      )
    )`);
  }
  const category = input.category ?? categoryOf(input.type);
  if (category !== "SYSTEM") {
    // Respect per-user opt-outs (SYSTEM notifications cannot be disabled).
    conditions.push(sql`not exists (
      select 1 from ${notificationPreferences} np
       where np.user_id = ${users.id} and np.category = ${category} and np.enabled = false)`);
  }
  const recipients = await db.select({ id: users.id }).from(users).where(and(...conditions));
  if (recipients.length === 0) return [];

  const inserted = await db
    .insert(notifications)
    .values(
    recipients.map((r) => ({
      organizationId: input.orgId,
      userId: r.id,
      type: input.type,
      category,
      dedupeKey: input.dedupeKey ?? null,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      projectId: input.projectId ?? null,
    })),
    )
    .onConflictDoNothing()
    .returning({ userId: notifications.userId });
  return inserted.map((r) => r.userId);
}
