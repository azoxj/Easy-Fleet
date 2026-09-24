import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import type { RoleKey } from "../src/auth/permissions.js";
import { db } from "../src/db/client.js";
import { DEFAULT_ORG_SLUG } from "../src/db/bootstrap.js";
import {
  assignments,
  drivers,
  employees,
  organizations,
  projects,
  projectUsers,
  roles,
  userRoles,
  users,
  vehicles,
} from "../src/db/schema/index.js";

export const app = createApp();
export const PASSWORD = "Test-Passw0rd!";
let cachedHash: string | undefined;

export const uid = () => randomBytes(4).toString("hex");

export async function defaultOrgId() {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, DEFAULT_ORG_SLUG));
  return org!.id;
}

export async function createUser(roleKeys: RoleKey[], opts: { mustChangePassword?: boolean; status?: "ACTIVE" | "DISABLED"; orgId?: string } = {}) {
  cachedHash ??= await hashPassword(PASSWORD);
  const orgId = opts.orgId ?? (await defaultOrgId());
  const email = `user-${uid()}@example.test`;
  const [u] = await db
    .insert(users)
    .values({
      organizationId: orgId,
      email,
      name: `مستخدم اختبار ${roleKeys.join("+")}`,
      passwordHash: cachedHash,
      mustChangePassword: opts.mustChangePassword ?? false,
      status: opts.status ?? "ACTIVE",
    })
    .returning();
  for (const key of roleKeys) {
    const [r] = await db.select().from(roles).where(and(eq(roles.key, key), isNull(roles.organizationId)));
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  }
  return { id: u!.id, email, password: PASSWORD, orgId };
}

export type Client = Awaited<ReturnType<typeof login>>;

/** Logs in and returns a client that carries the session cookie + CSRF token. */
export async function login(email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf: string = res.body.data.csrfToken;
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set("X-CSRF-Token", csrf).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set("X-CSRF-Token", csrf).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set("X-CSRF-Token", csrf).send(body ?? {}),
    delete: (url: string) => agent.delete(url).set("X-CSRF-Token", csrf),
  };
}

export async function userAndClient(roleKeys: RoleKey[]) {
  const u = await createUser(roleKeys);
  return { user: u, client: await login(u.email) };
}

export async function createProject(opts: { managerId?: string | null; members?: string[] } = {}) {
  const orgId = await defaultOrgId();
  const code = `P-${uid().toUpperCase()}`;
  const [p] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: `مشروع ${code}`, code, managerId: opts.managerId ?? null, status: "ACTIVE" })
    .returning();
  const members = new Set([...(opts.members ?? []), ...(opts.managerId ? [opts.managerId] : [])]);
  for (const m of members) await db.insert(projectUsers).values({ projectId: p!.id, userId: m });
  return p!;
}

export async function createVehicle(projectId: string | null, extra: Partial<typeof vehicles.$inferInsert> = {}) {
  const orgId = await defaultOrgId();
  const [v] = await db
    .insert(vehicles)
    .values({ organizationId: orgId, plateNumber: `T-${uid()}`, make: "اختبار", model: "X", projectId, ...extra })
    .returning();
  return v!;
}

export async function assignVehicle(vehicle: { id: string; projectId: string | null }, assignedTo: string, assignedBy: string) {
  const orgId = await defaultOrgId();
  const [a] = await db
    .insert(assignments)
    .values({
      organizationId: orgId,
      type: "VEHICLE",
      assignedTo,
      assignedBy,
      projectId: vehicle.projectId,
      vehicleId: vehicle.id,
      referenceId: vehicle.id,
      title: "إسناد مركبة",
    })
    .returning();
  return a!;
}

export async function linkDriver(userId: string, vehicleId: string) {
  const orgId = await defaultOrgId();
  const [e] = await db.insert(employees).values({ organizationId: orgId, employeeNumber: `E-${uid()}`, name: "سائق", userId }).returning();
  const [d] = await db.insert(drivers).values({ organizationId: orgId, employeeId: e!.id }).returning();
  await db.update(vehicles).set({ assignedDriverId: d!.id }).where(eq(vehicles.id, vehicleId));
  return d!;
}
