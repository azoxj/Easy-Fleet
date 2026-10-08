import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_PERMISSION_KEYS, ROLES } from "../src/auth/permissions.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { auditLogs, integrationReviewQueue, integrationSettings, integrationSyncRuns, organizations } from "../src/db/schema/index.js";
import { normalizeBaseUrl } from "../src/integrations/base-url.js";
import { BrightWashingProvider } from "../src/integrations/bright-washing.js";
import { decideMatch } from "../src/integrations/matching.js";
import { matchOrQueue } from "../src/integrations/service.js";
import { createUser, defaultOrgId, login, userAndClient } from "./helpers.js";

const API_KEY = "bw-api-key-SECRET-123456";
const CLIENT_SECRET = "bw-client-secret-SECRET-654321";
let orgId: string;
const logs: string[] = [];
const origLog = console.log;

beforeAll(async () => {
  orgId = await defaultOrgId();
  (config as { EMAIL_SETTINGS_KEY?: string }).EMAIL_SETTINGS_KEY = Buffer.alloc(32, 9).toString("base64");
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});

afterAll(async () => {
  console.log = origLog;
  (config as { EMAIL_SETTINGS_KEY?: string }).EMAIL_SETTINGS_KEY = undefined;
  await db.delete(integrationSettings).where(eq(integrationSettings.organizationId, orgId));
  await db.delete(integrationSyncRuns).where(eq(integrationSyncRuns.organizationId, orgId));
});

describe("permission integrations.manage", () => {
  it("only the system administrator role holds it", () => {
    expect(ALL_PERMISSION_KEYS).toContain("integrations.manage");
    const holders = Object.entries(ROLES).filter(([, r]) => r.grants["integrations.manage"]).map(([k]) => k);
    expect(holders).toEqual(["SUPER_ADMIN"]);
  });

  it("every other role gets 403 on every route; anonymous gets 401", async () => {
    for (const role of ["PROJECT_MANAGER", "FINANCE", "TECHNICAL", "USER", "DRIVER", "VIEWER"] as const) {
      const { client } = await userAndClient([role]);
      expect((await client.get("/api/integrations")).status, role).toBe(403);
      expect((await client.get("/api/integrations/bright-washing")).status, role).toBe(403);
      expect((await client.put("/api/integrations/bright-washing", { enabled: true })).status, role).toBe(403);
      expect((await client.post("/api/integrations/bright-washing/test")).status, role).toBe(403);
      expect((await client.post("/api/integrations/bright-washing/sync")).status, role).toBe(403);
      expect((await client.get("/api/integrations/bright-washing/runs")).status, role).toBe(403);
      expect((await client.get("/api/integrations/bright-washing/review")).status, role).toBe(403);
    }
    const request = (await import("supertest")).default;
    const { app } = await import("./helpers.js");
    expect((await request(app).get("/api/integrations")).status).toBe(401);
  });
});

describe("Bright Washing integration (infrastructure only)", () => {
  it("starts disabled; test and sync are refused (409) while disabled and nothing is recorded", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const v = await client.get("/api/integrations/bright-washing");
    expect(v.body.data).toMatchObject({ enabled: false, status: "DISABLED", apiKeySaved: false });
    expect((await client.post("/api/integrations/bright-washing/test")).status).toBe(409);
    expect((await client.post("/api/integrations/bright-washing/sync")).status).toBe(409);
    expect(await db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.organizationId, orgId))).toHaveLength(0);
  });

  it("enabling without settings reports 'waiting for the API' — no fake connection", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    expect((await client.put("/api/integrations/bright-washing", { enabled: true })).status).toBe(200);
    const t = await client.post("/api/integrations/bright-washing/test");
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ status: "WAITING_FOR_API", message: "بانتظار إعداد API الغسيل الساطع" });
    const s = await client.post("/api/integrations/bright-washing/sync");
    expect(s.body.data).toMatchObject({ status: "WAITING_FOR_API", reasonCode: "NOT_CONFIGURED", recordsProcessed: 0, recordsCreated: 0 });
    expect(s.body.data.completedAt).toBeTruthy();
    const en = await client.agent.post("/api/integrations/bright-washing/test").set("X-CSRF-Token", client.csrf).set("X-Locale", "en").send({});
    expect(en.body.data.message).toBe("Waiting for the Bright Washing API setup");
  });

  it("secrets are encrypted, write-only, and never appear in responses, audit or logs", async () => {
    const { client, user } = await userAndClient(["SUPER_ADMIN"]);
    const r = await client.put("/api/integrations/bright-washing", { baseUrl: "https://api.example.com/v1/", clientId: "client-1", apiKey: API_KEY, clientSecret: CLIENT_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ baseUrl: "https://api.example.com/v1", clientId: "client-1", apiKeySaved: true, clientSecretSaved: true, status: "WAITING_FOR_API" });
    const view = await client.get("/api/integrations/bright-washing");
    for (const body of [JSON.stringify(r.body), JSON.stringify(view.body)]) {
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain(CLIENT_SECRET);
      expect(body).not.toMatch(/v1:[A-Za-z0-9+/=]+:/);
    }
    const [row] = await db.select().from(integrationSettings).where(eq(integrationSettings.organizationId, orgId));
    expect(row!.apiKeyEnc).toMatch(/^v1:/);
    expect(row!.apiKeyEnc).not.toContain(API_KEY);
    expect(row!.clientSecretEnc).not.toContain(CLIENT_SECRET);
    // configured but the real adapter does not exist yet
    const s = await client.post("/api/integrations/bright-washing/sync");
    expect(s.body.data).toMatchObject({ status: "WAITING_FOR_API", reasonCode: "ADAPTER_PENDING" });
    const audit = JSON.stringify(await db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(200));
    expect(audit).not.toContain(API_KEY);
    expect(audit).not.toContain(CLIENT_SECRET);
    expect(logs.join("\n")).not.toContain(API_KEY);
    // omitted = keep; "" = remove
    await client.put("/api/integrations/bright-washing", { clientId: "client-2" });
    expect((await client.get("/api/integrations/bright-washing")).body.data.apiKeySaved).toBe(true);
    await client.put("/api/integrations/bright-washing", { clientSecret: "" });
    const after = (await client.get("/api/integrations/bright-washing")).body.data;
    expect(after).toMatchObject({ clientSecretSaved: false, apiKeySaved: true });
    void user;
  });

  it("secrets cannot be stored without the server key", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    (config as { EMAIL_SETTINGS_KEY?: string }).EMAIL_SETTINGS_KEY = undefined;
    try {
      expect((await client.put("/api/integrations/bright-washing", { apiKey: "x-y-z" })).status).toBe(400);
    } finally {
      (config as { EMAIL_SETTINGS_KEY?: string }).EMAIL_SETTINGS_KEY = Buffer.alloc(32, 9).toString("base64");
    }
  });

  it("rejects unsafe base URLs", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    for (const bad of ["http://api.example.com", "https://user:pw@api.example.com", "https://localhost/x", "https://127.0.0.1", "https://10.0.0.5/api", "https://api.example.com/?token=1", "not a url", "https://intranet"]) {
      expect((await client.put("/api/integrations/bright-washing", { baseUrl: bad })).status, bad).toBe(400);
    }
    expect(normalizeBaseUrl("https://API.example.com/path//")).toBe("https://api.example.com/path");
  });

  it("writes audit entries for enable/disable, settings changes, test and sync runs", async () => {
    const { client, user } = await userAndClient(["SUPER_ADMIN"]);
    await client.put("/api/integrations/bright-washing", { enabled: false });
    await client.put("/api/integrations/bright-washing", { enabled: true, clientId: "c3" });
    await client.post("/api/integrations/bright-washing/test");
    await client.post("/api/integrations/bright-washing/sync");
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.userId, user.id));
    const actions = rows.map((r) => r.action);
    for (const a of ["INTEGRATION_DISABLED", "INTEGRATION_ENABLED", "INTEGRATION_SETTINGS_UPDATED", "INTEGRATION_TEST", "INTEGRATION_SYNC_RUN"]) expect(actions, a).toContain(a);
    const runs = await client.get("/api/integrations/bright-washing/runs");
    expect(runs.body.data[0]).toMatchObject({ status: "WAITING_FOR_API" });
  });

  it("is isolated per organization", async () => {
    const [other] = await db.insert(organizations).values({ name: "شركة أخرى", slug: `int-other-${Date.now()}` }).returning();
    const u = await createUser(["SUPER_ADMIN"], { orgId: other!.id });
    const c = await login(u.email);
    const v = await c.get("/api/integrations/bright-washing");
    expect(v.body.data).toMatchObject({ enabled: false, apiKeySaved: false, baseUrl: null, lastRun: null });
    expect((await c.get("/api/integrations/bright-washing/runs")).body.data).toEqual([]);
    expect((await c.post("/api/integrations/bright-washing/sync")).status).toBe(409);
  });
});

describe("provider abstraction", () => {
  const p = new BrightWashingProvider();
  const empty = { baseUrl: null, apiKey: null, clientId: null, clientSecret: null };
  it("never pretends: every operation waits for the API and returns no data", async () => {
    expect(await p.testConnection(empty)).toEqual({ ok: false, state: "WAITING_FOR_API", reason: "NOT_CONFIGURED" });
    expect(await p.syncWashes(empty)).toEqual({ state: "WAITING_FOR_API", reason: "NOT_CONFIGURED" });
    expect(await p.getWash(empty)).toEqual({ state: "WAITING_FOR_API", reason: "NOT_CONFIGURED" });
    const cfg = { ...empty, baseUrl: "https://api.example.com", apiKey: "k" };
    expect(await p.getSyncStatus(cfg)).toEqual({ state: "WAITING_FOR_API", reason: "ADAPTER_PENDING" });
  });
});

describe("vehicle matching and the review queue", () => {
  it("decideMatch: exactly one → matched; none → NO_MATCH; several → AMBIGUOUS", () => {
    expect(decideMatch(["a"])).toEqual({ kind: "MATCHED", vehicleId: "a" });
    expect(decideMatch(["a", "a"])).toEqual({ kind: "MATCHED", vehicleId: "a" });
    expect(decideMatch([])).toEqual({ kind: "REVIEW", reason: "NO_MATCH", candidates: [] });
    expect(decideMatch(["a", "b"])).toEqual({ kind: "REVIEW", reason: "AMBIGUOUS", candidates: ["a", "b"] });
  });

  it("unmatched and ambiguous records are queued once, nothing is created", async () => {
    const ext = `wash-${Date.now()}`;
    const none = { findVehicleIdsByPlate: async () => [] as string[] };
    const two = { findVehicleIdsByPlate: async () => ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"] };
    const rec = { organizationId: orgId, provider: "BRIGHT_WASHING", externalId: ext, plateRaw: "ABC 123" };
    expect((await matchOrQueue(db, none, rec)).kind).toBe("REVIEW");
    await matchOrQueue(db, none, rec); // duplicate while pending → still one row
    expect((await matchOrQueue(db, two, { ...rec, externalId: `${ext}-2` })).kind).toBe("REVIEW");
    const rows = await db.select().from(integrationReviewQueue).where(and(eq(integrationReviewQueue.organizationId, orgId), eq(integrationReviewQueue.status, "PENDING")));
    expect(rows.filter((r) => r.externalId.startsWith(ext)).map((r) => r.reason).sort()).toEqual(["AMBIGUOUS", "NO_MATCH"]);
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const q = await client.get("/api/integrations/bright-washing/review");
    expect(q.body.data.length).toBeGreaterThanOrEqual(2);
    await db.delete(integrationReviewQueue).where(eq(integrationReviewQueue.organizationId, orgId));
  });
});
