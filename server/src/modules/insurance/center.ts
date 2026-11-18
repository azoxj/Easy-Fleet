import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { vehicleScope } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { accidentClaims, accidents, insurancePolicies, projects, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";
import { paged, pagination, uuid } from "../../http/validate.js";
import { addDays, today } from "../../lib/clock.js";
import { EXPIRING_SOON_DAYS } from "../../services/expiry.js";
import { loadFacts } from "../accidents/case-service.js";
import { missingForTransition } from "../accidents/requirements.js";
import { caseVisibility } from "../accidents/visibility.js";

/**
 * The insurance office screens: policies and their renewal, claims and their decisions, compensations, and what is missing.
 * Policies follow the user's `insurance.read` scope (central account: every project; a project user: his projects) and claims
 * follow the accident visibility rule, so nothing here shows more than the module lists do.
 */
export const insuranceCenterRouter = Router();
const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

/** Active = the newest (not superseded) policy of the vehicle. */
const currentPolicy = sql`${insurancePolicies.supersededAt} is null`;

insuranceCenterRouter.get("/insurance-center/dashboard", requirePermission("insurance.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const t = today();
  const soon = addDays(t, EXPIRING_SOON_DAYS);
  const vScope = vehicleScope(a, "insurance.read");
  const [p] = await db
    .select({
      active: sql<number>`count(*) filter (where ${insurancePolicies.expiryDate} >= ${t}::date)::int`,
      expiring: sql<number>`count(*) filter (where ${insurancePolicies.expiryDate} >= ${t}::date and ${insurancePolicies.expiryDate} <= ${soon}::date)::int`,
      expired: sql<number>`count(*) filter (where ${insurancePolicies.expiryDate} < ${t}::date)::int`,
    })
    .from(insurancePolicies).innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId))
    .where(and(vScope, currentPolicy, eq(insurancePolicies.organizationId, a.orgId)));
  const [noPolicy] = await db
    .select({ n: sql<number>`count(*)::int` }).from(vehicles)
    .where(and(vScope, sql`${vehicles.status} <> 'ARCHIVED'`, sql`not exists (select 1 from insurance_policies ip where ip.vehicle_id = ${vehicles.id} and ip.superseded_at is null)`));
  const vis = a.has("accidents.read") ? and(eq(accidents.organizationId, a.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(a)) : sql`false`;
  const [c] = await db
    .select({
      newClaims: sql<number>`count(*) filter (where ${accidents.workflowStage} = 'AWAITING_INSURANCE')::int`,
      inProgress: sql<number>`count(*) filter (where ${accidentClaims.status} in ('FILED','PROCESSING'))::int`,
      rejected: sql<number>`count(*) filter (where ${accidentClaims.status} = 'REJECTED')::int`,
      approvedCount: sql<number>`count(*) filter (where ${accidentClaims.status} = 'APPROVED')::int`,
      approvedAmount: sql<string>`coalesce(sum(${accidentClaims.approvedAmount}) filter (where ${accidentClaims.status} = 'APPROVED'), 0)::text`,
      atFinance: sql<number>`count(*) filter (where ${accidents.workflowStage} = 'AWAITING_FINANCE_REVIEW' and ${accidentClaims.status} = 'APPROVED')::int`,
      receivedCount: sql<number>`count(*) filter (where ${accidentClaims.status} = 'COMPENSATION_RECEIVED')::int`,
      receivedAmount: sql<string>`coalesce(sum(${accidentClaims.receivedAmount}) filter (where ${accidentClaims.status} = 'COMPENSATION_RECEIVED'), 0)::text`,
    })
    .from(accidents).leftJoin(accidentClaims, eq(accidentClaims.accidentId, accidents.id)).where(vis);
  const [rej] = await db.select({ n: sql<number>`count(*)::int` }).from(accidents).where(and(vis, sql`${accidents.workflowStage} = 'AWAITING_TECHNICAL_DECISION'`, sql`exists (select 1 from accident_claims c where c.accident_id = ${accidents.id} and c.status = 'REJECTED')`));
  const byProject = await db
    .select({ projectId: projects.id, name: projects.name, claims: sql<number>`count(${accidentClaims.id})::int`, approved: sql<string>`coalesce(sum(${accidentClaims.approvedAmount}) filter (where ${accidentClaims.status} in ('APPROVED','COMPENSATION_RECEIVED')), 0)::text`, received: sql<string>`coalesce(sum(${accidentClaims.receivedAmount}) filter (where ${accidentClaims.status} = 'COMPENSATION_RECEIVED'), 0)::text` })
    .from(accidents).innerJoin(accidentClaims, eq(accidentClaims.accidentId, accidents.id)).innerJoin(projects, eq(projects.id, accidents.projectId)).where(vis).groupBy(projects.id, projects.name).orderBy(asc(projects.name));
  res.json({
    data: {
      policies: { active: p?.active ?? 0, expiring: p?.expiring ?? 0, expired: p?.expired ?? 0, vehiclesWithoutPolicy: noPolicy?.n ?? 0, expiringDays: EXPIRING_SOON_DAYS },
      claims: { new: c?.newClaims ?? 0, inProgress: c?.inProgress ?? 0, rejected: c?.rejected ?? 0, rejectedWaiting: rej?.n ?? 0, approved: c?.approvedCount ?? 0 },
      compensation: { awaitingTransfer: money(c?.approvedAmount), awaitingCount: c?.approvedCount ?? 0, atFinance: c?.atFinance ?? 0, received: money(c?.receivedAmount), receivedCount: c?.receivedCount ?? 0 },
      projects: byProject.map((r) => ({ ...r, approved: money(r.approved), received: money(r.received) })),
    },
  });
});

const PolicyQuery = pagination.extend({ status: z.enum(["all", "active", "expiring", "expired"]).default("all"), projectId: uuid.optional(), vehicleId: uuid.optional(), q: z.string().trim().max(100).optional() });

insuranceCenterRouter.get("/insurance-center/policies", requirePermission("insurance.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const q = PolicyQuery.parse(req.query);
  const t = today();
  const soon = addDays(t, EXPIRING_SOON_DAYS);
  const where: SQL[] = [vehicleScope(a, "insurance.read"), eq(insurancePolicies.organizationId, a.orgId), currentPolicy];
  if (q.status === "active") where.push(sql`${insurancePolicies.expiryDate} >= ${t}::date`);
  if (q.status === "expiring") where.push(sql`${insurancePolicies.expiryDate} >= ${t}::date and ${insurancePolicies.expiryDate} <= ${soon}::date`);
  if (q.status === "expired") where.push(sql`${insurancePolicies.expiryDate} < ${t}::date`);
  if (q.projectId) where.push(eq(vehicles.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(vehicles.id, q.vehicleId));
  if (q.q) where.push(or(ilike(vehicles.plateNumber, like(q.q)), ilike(insurancePolicies.policyNumber, like(q.q)), ilike(insurancePolicies.provider, like(q.q)))!);
  const cond = and(...where);
  const [rows, [total]] = await Promise.all([
    db.select({ id: insurancePolicies.id, vehicleId: vehicles.id, plateNumber: vehicles.plateNumber, projectId: vehicles.projectId, projectName: projects.name, provider: insurancePolicies.provider, policyNumber: insurancePolicies.policyNumber, coverageType: insurancePolicies.coverageType, issueDate: insurancePolicies.issueDate, expiryDate: insurancePolicies.expiryDate, premiumAmount: insurancePolicies.premiumAmount, hasFile: sql<boolean>`${insurancePolicies.fileId} is not null`, daysLeft: sql<number>`(${insurancePolicies.expiryDate} - ${t}::date)::int` })
      .from(insurancePolicies).innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId)).leftJoin(projects, eq(projects.id, vehicles.projectId))
      .where(cond).orderBy(asc(insurancePolicies.expiryDate)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(insurancePolicies).innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId)).where(cond),
  ]);
  res.json(paged(rows.map((r) => ({ ...r, state: r.daysLeft < 0 ? "EXPIRED" : r.daysLeft <= EXPIRING_SOON_DAYS ? "EXPIRING" : "ACTIVE" })), total?.n ?? 0, q.page, q.pageSize));
});

const ClaimQuery = pagination.extend({
  lane: z.enum(["all", "new", "inProgress", "approved", "rejected", "atFinance", "received"]).default("all"),
  projectId: uuid.optional(), vehicleId: uuid.optional(), status: z.string().trim().max(30).optional(), q: z.string().trim().max(100).optional(),
});

/** Claims and compensations of the cases the user sees: lanes cover decisions (accepted/rejected), awaiting transfer, at finance, received. */
insuranceCenterRouter.get("/insurance-center/claims", requirePermission("accidents.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const q = ClaimQuery.parse(req.query);
  const where: SQL[] = [eq(accidents.organizationId, a.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(a)];
  const lane: Record<string, SQL | undefined> = {
    new: sql`${accidents.workflowStage} = 'AWAITING_INSURANCE'`,
    inProgress: sql`${accidentClaims.status} in ('FILED','PROCESSING','PREPARING')`,
    approved: sql`${accidentClaims.status} = 'APPROVED' and ${accidents.workflowStage} = 'AWAITING_COMPENSATION_PROOF'`,
    rejected: sql`${accidentClaims.status} = 'REJECTED'`,
    atFinance: sql`${accidentClaims.status} = 'APPROVED' and ${accidents.workflowStage} = 'AWAITING_FINANCE_REVIEW'`,
    received: sql`${accidentClaims.status} = 'COMPENSATION_RECEIVED'`,
  };
  if (q.lane !== "all") where.push(lane[q.lane]!);
  else where.push(or(sql`${accidentClaims.id} is not null`, sql`${accidents.workflowStage} = 'AWAITING_INSURANCE'`)!);
  if (q.projectId) where.push(eq(accidents.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(accidents.vehicleId, q.vehicleId));
  if (q.status) where.push(sql`${accidentClaims.status}::text = ${q.status}`);
  if (q.q) {
    const m = /^acc-?(\d+)$/i.exec(q.q);
    where.push(m ? eq(accidents.number, Number(m[1])) : or(ilike(vehicles.plateNumber, like(q.q)), ilike(accidentClaims.claimNumber, like(q.q)), ilike(accidentClaims.insurerName, like(q.q)))!);
  }
  const cond = and(...where);
  const from = () => db.select({
    id: accidents.id, number: accidents.number, plateNumber: vehicles.plateNumber, vehicleId: vehicles.id, projectId: accidents.projectId, projectName: projects.name,
    stage: accidents.workflowStage, insurerName: accidentClaims.insurerName, claimNumber: accidentClaims.claimNumber, claimStatus: accidentClaims.status,
    claimedAmount: accidentClaims.claimedAmount, approvedAmount: accidentClaims.approvedAmount, receivedAmount: accidentClaims.receivedAmount,
    rejectionReason: accidentClaims.rejectionReason, filedAt: accidentClaims.filedAt, decidedAt: accidentClaims.decidedAt, receivedAt: accidentClaims.receivedAt,
  }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).leftJoin(projects, eq(projects.id, accidents.projectId)).leftJoin(accidentClaims, eq(accidentClaims.accidentId, accidents.id));
  const [rows, [total]] = await Promise.all([
    from().where(cond).orderBy(desc(accidents.number)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).leftJoin(accidentClaims, eq(accidentClaims.accidentId, accidents.id)).where(cond),
  ]);
  res.json(paged(rows.map((r) => ({ ...r, label: `ACC-${r.number}` })), total?.n ?? 0, q.page, q.pageSize));
});

/** What is missing: the cases with insurance whose next step lacks something, and the vehicles with no current policy. */
insuranceCenterRouter.get("/insurance-center/requirements", requirePermission("accidents.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const rows = await db
    .select({ acc: accidents, plateNumber: vehicles.plateNumber, projectName: projects.name })
    .from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).leftJoin(projects, eq(projects.id, accidents.projectId))
    .where(and(eq(accidents.organizationId, a.orgId), caseVisibility(a), sql`${accidents.workflowStage} in ('AWAITING_INSURANCE','CLAIM_IN_PROGRESS','AWAITING_COMPENSATION_PROOF')`))
    .orderBy(desc(accidents.number)).limit(100);
  const NEXT: Record<string, "CLAIM_IN_PROGRESS" | "AWAITING_COMPENSATION_PROOF" | "AWAITING_FINANCE_REVIEW"> = { AWAITING_INSURANCE: "CLAIM_IN_PROGRESS", CLAIM_IN_PROGRESS: "AWAITING_COMPENSATION_PROOF", AWAITING_COMPENSATION_PROOF: "AWAITING_FINANCE_REVIEW" };
  const cases = [];
  for (const r of rows) {
    const stage = r.acc.workflowStage!;
    const missing = missingForTransition(stage as never, NEXT[stage] as never, await loadFacts(db, r.acc));
    // A claim still being processed is not "missing" the approval: only attachments and details are chased here.
    const chase = missing.filter((m) => m.startsWith("attachment:") || m === "claim.missing" || m === "claim.details");
    if (chase.length) cases.push({ id: r.acc.id, label: `ACC-${r.acc.number}`, plateNumber: r.plateNumber, projectName: r.projectName, stage, missing: chase });
  }
  const noPolicy = a.has("insurance.read")
    ? await db.select({ id: vehicles.id, plateNumber: vehicles.plateNumber, projectName: projects.name }).from(vehicles).leftJoin(projects, eq(projects.id, vehicles.projectId))
        .where(and(vehicleScope(a, "insurance.read"), sql`${vehicles.status} <> 'ARCHIVED'`, sql`not exists (select 1 from insurance_policies ip where ip.vehicle_id = ${vehicles.id} and ip.superseded_at is null)`)).orderBy(asc(vehicles.plateNumber)).limit(100)
    : [];
  res.json({ data: { cases, vehiclesWithoutPolicy: noPolicy } });
});
