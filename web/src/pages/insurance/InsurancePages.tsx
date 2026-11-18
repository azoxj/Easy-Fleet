import { useState } from "react";
import { Link } from "react-router";
import { Money, ProjectSelect, useProjects } from "../../components/shared";
import { Alert, Badge, Card, CardHeader, EmptyState, Input, Loading, PageHeader, Pagination, StatCard, Tabs } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { t } from "../../i18n";
import type { Paged } from "../../lib/api";
import { claimStatusLabel, docLabel, requirementText, stageLabel } from "../../lib/accidentWorkflow";
import { formatDate } from "../../lib/format";

type Dash = {
  policies: { active: number; expiring: number; expired: number; vehiclesWithoutPolicy: number; expiringDays: number };
  claims: { new: number; inProgress: number; rejected: number; rejectedWaiting: number; approved: number };
  compensation: { awaitingTransfer: string; awaitingCount: number; atFinance: number; received: string; receivedCount: number };
  projects: { projectId: string; name: string; claims: number; approved: string; received: string }[];
};

/** The central insurance dashboard: policies and renewals, claims and decisions, compensation — across every project. */
export function InsuranceDashboardPage() {
  const { data, loading, error } = useApi<{ data: Dash }>("/insurance-center/dashboard");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const d = data.data;
  return (
    <>
      <PageHeader title={t("ins.nav.dashboard")} subtitle={t("ins.dash.subtitle")} />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="ins-policies">
        <StatCard label={t("ins.kpi.active")} value={d.policies.active} icon="shield" tone="green" to="/insurance/policies?status=active" />
        <StatCard label={t("ins.kpi.expiring", { days: d.policies.expiringDays })} value={d.policies.expiring} icon="clock" tone={d.policies.expiring > 0 ? "amber" : "gray"} to="/insurance/policies?status=expiring" />
        <StatCard label={t("ins.kpi.expired")} value={d.policies.expired} icon="alert" tone={d.policies.expired > 0 ? "red" : "gray"} to="/insurance/policies?status=expired" />
        <StatCard label={t("ins.kpi.noPolicy")} value={d.policies.vehiclesWithoutPolicy} icon="truck" tone={d.policies.vehiclesWithoutPolicy > 0 ? "violet" : "gray"} to="/insurance/requirements" />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="ins-claims">
        <StatCard label={t("ins.kpi.newClaims")} value={d.claims.new} icon="inbox" tone="blue" to="/insurance/claims?lane=new" />
        <StatCard label={t("ins.kpi.inProgress")} value={d.claims.inProgress} icon="clock" tone="amber" to="/insurance/claims?lane=inProgress" />
        <StatCard label={t("ins.kpi.rejected")} value={d.claims.rejected} hint={d.claims.rejectedWaiting ? t("ins.kpi.rejectedWaiting", { count: d.claims.rejectedWaiting }) : undefined} icon="alert" tone={d.claims.rejected > 0 ? "red" : "gray"} to="/insurance/claims?lane=rejected" />
        <StatCard label={t("ins.kpi.approved")} value={d.claims.approved} icon="check" tone="green" to="/insurance/claims?lane=approved" />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="ins-compensation">
        <StatCard label={t("ins.kpi.awaitingTransfer")} value={<Money value={d.compensation.awaitingTransfer} />} hint={t("fin.kpi.claimsCount", { count: d.compensation.awaitingCount })} icon="clock" tone="amber" to="/insurance/compensations?lane=approved" />
        <StatCard label={t("ins.kpi.atFinance")} value={d.compensation.atFinance} icon="receipt" tone="violet" to="/insurance/compensations?lane=atFinance" />
        <StatCard label={t("ins.kpi.received")} value={<Money value={d.compensation.received} />} hint={t("fin.kpi.claimsCount", { count: d.compensation.receivedCount })} icon="check" tone="green" to="/insurance/compensations?lane=received" />
      </div>
      <Card>
        <CardHeader title={t("ins.dash.perProject")} />
        {d.projects.length === 0 ? <EmptyState icon="folder" title={t("ins.dash.noClaims")} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="ins-projects">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-2 text-start">{t("common.project")}</th><th className="px-4 py-2 text-start">{t("ins.nav.claims")}</th><th className="px-4 py-2 text-start">{t("fin.acc.approved")}</th><th className="px-4 py-2 text-start">{t("fin.acc.received")}</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {d.projects.map((p) => <tr key={p.projectId}><td className="px-4 py-2.5 font-medium">{p.name}</td><td className="px-4 py-2.5">{p.claims}</td><td className="px-4 py-2.5"><Money value={p.approved} /></td><td className="px-4 py-2.5"><Money value={p.received} /></td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

type PolicyRow = { id: string; vehicleId: string; plateNumber: string; projectName: string | null; provider: string; policyNumber: string; coverageType: string; expiryDate: string; premiumAmount: string | null; daysLeft: number; state: "ACTIVE" | "EXPIRING" | "EXPIRED"; hasFile: boolean };
const COVERAGE = () => ({ THIRD_PARTY: t("ins.coverage.THIRD_PARTY"), COMPREHENSIVE: t("ins.coverage.COMPREHENSIVE"), OTHER: t("ins.coverage.OTHER") }) as Record<string, string>;

/** Vehicle insurance policies of every project with expiry dates and renewal alerts. */
export function InsurancePoliciesPage() {
  const projects = useProjects();
  const [status, setStatus] = useState(new URLSearchParams(location.search).get("status") ?? "all");
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<PolicyRow>>("/insurance-center/policies", { status, projectId: projectId || undefined, q: q.trim() || undefined, page });
  const tabs = [{ key: "all", label: t("ins.pol.all") }, { key: "active", label: t("ins.pol.active") }, { key: "expiring", label: t("ins.pol.expiring") }, { key: "expired", label: t("ins.pol.expired") }];
  const cov = COVERAGE();
  return (
    <>
      <PageHeader title={t("ins.nav.policies")} subtitle={t("ins.pol.subtitle")} />
      <Card>
        <div className="space-y-3 border-b border-slate-100 px-4 py-3">
          <Tabs tabs={tabs} active={status} onChange={(k) => { setStatus(k); setPage(1); }} />
          <div className="flex flex-wrap gap-2">
            <Input className="max-w-xs" placeholder={t("ins.pol.search")} aria-label={t("ins.pol.search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            {projects.length > 1 && <ProjectSelect value={projectId} onChange={(v) => { setProjectId(v); setPage(1); }} projects={projects} />}
          </div>
        </div>
        {loading && !data ? <Loading /> : error || !data ? <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert> : data.data.length === 0 ? <EmptyState icon="shield" title={t("ins.pol.none")} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="ins-policy-rows">
                <thead className="bg-slate-50 text-xs text-slate-500"><tr>{["common.vehicle", "common.project", "ins.pol.provider", "ins.pol.number", "ins.pol.coverage", "ins.pol.expiry", "ins.pol.premium", "common.status"].map((k) => <th key={k} className="px-3 py-2 text-start whitespace-nowrap">{t(k as never)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.data.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 whitespace-nowrap"><Link className="font-semibold text-brand-700 ltr hover:underline" to={`/vehicles/${r.vehicleId}`}>{r.plateNumber}</Link></td>
                      <td className="px-3 py-2.5">{r.projectName ?? "—"}</td>
                      <td className="px-3 py-2.5">{r.provider}</td>
                      <td className="px-3 py-2.5 ltr">{r.policyNumber}</td>
                      <td className="px-3 py-2.5">{cov[r.coverageType] ?? r.coverageType}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(r.expiryDate)}</td>
                      <td className="px-3 py-2.5"><Money value={r.premiumAmount} /></td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.state === "EXPIRED" ? <Badge tone="red" dot>{t("ins.pol.state.EXPIRED")}</Badge> : r.state === "EXPIRING" ? <Badge tone="amber" dot>{t("ins.pol.state.EXPIRING", { days: r.daysLeft })}</Badge> : <Badge tone="green" dot>{t("ins.pol.state.ACTIVE")}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

type ClaimRow = { id: string; label: string; plateNumber: string; projectName: string | null; stage: string; insurerName: string | null; claimNumber: string | null; claimStatus: string | null; claimedAmount: string | null; approvedAmount: string | null; receivedAmount: string | null; rejectionReason: string | null; filedAt: string | null };

/** Claims with their decisions, and (compensation mode) the approved, awaiting-transfer, at-finance and collected amounts. */
export function InsuranceClaimsPage({ compensation = false }: { compensation?: boolean }) {
  const projects = useProjects();
  const lanes = compensation
    ? [{ key: "all", label: t("ins.comp.all") }, { key: "approved", label: t("ins.comp.awaiting") }, { key: "atFinance", label: t("ins.comp.atFinance") }, { key: "received", label: t("ins.comp.received") }]
    : [{ key: "all", label: t("ins.claims.all") }, { key: "new", label: t("ins.claims.new") }, { key: "inProgress", label: t("ins.claims.inProgress") }, { key: "approved", label: t("ins.claims.approved") }, { key: "rejected", label: t("ins.claims.rejected") }, { key: "received", label: t("ins.claims.received") }];
  const initial = new URLSearchParams(location.search).get("lane");
  const [lane, setLane] = useState(initial && lanes.some((l) => l.key === initial) ? initial : "all");
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<ClaimRow>>("/insurance-center/claims", { lane, projectId: projectId || undefined, q: q.trim() || undefined, page });
  return (
    <>
      <PageHeader title={compensation ? t("ins.nav.compensations") : t("ins.nav.claims")} subtitle={compensation ? t("ins.comp.subtitle") : t("ins.claims.subtitle")} />
      <Card>
        <div className="space-y-3 border-b border-slate-100 px-4 py-3">
          <Tabs tabs={lanes} active={lane} onChange={(k) => { setLane(k); setPage(1); }} />
          <div className="flex flex-wrap gap-2">
            <Input className="max-w-xs" placeholder={t("ins.claims.search")} aria-label={t("ins.claims.search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            {projects.length > 1 && <ProjectSelect value={projectId} onChange={(v) => { setProjectId(v); setPage(1); }} projects={projects} />}
          </div>
        </div>
        {loading && !data ? <Loading /> : error || !data ? <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert> : data.data.length === 0 ? <EmptyState icon="alert" title={t("accidentFlow.board.empty")} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="ins-claim-rows">
                <thead className="bg-slate-50 text-xs text-slate-500"><tr>{["accidents.accident", "common.project", "fin.claim.insurer", "fin.claim.number", "common.status", "fin.acc.claimed", "fin.acc.approved", "fin.acc.received", "ins.claims.reason"].map((k) => <th key={k} className="px-3 py-2 text-start whitespace-nowrap">{t(k as never)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.data.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 whitespace-nowrap"><Link className="font-semibold text-brand-700 ltr hover:underline" to={`/accidents/${r.id}`}>{r.label}</Link> <span className="text-xs text-slate-500 ltr">{r.plateNumber}</span></td>
                      <td className="px-3 py-2.5">{r.projectName ?? "—"}</td>
                      <td className="px-3 py-2.5">{r.insurerName ?? "—"}</td>
                      <td className="px-3 py-2.5 ltr">{r.claimNumber ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.claimStatus ? <Badge tone={r.claimStatus === "COMPENSATION_RECEIVED" || r.claimStatus === "APPROVED" ? "green" : r.claimStatus === "REJECTED" ? "red" : "amber"} dot>{claimStatusLabel(r.claimStatus)}</Badge> : <span className="text-xs text-slate-500">{stageLabel(r.stage)}</span>}</td>
                      <td className="px-3 py-2.5"><Money value={r.claimedAmount} /></td>
                      <td className="px-3 py-2.5"><Money value={r.approvedAmount} /></td>
                      <td className="px-3 py-2.5"><Money value={r.receivedAmount} /></td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">{r.rejectionReason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

/** What is missing: cases with insurance whose next step lacks a document or details, and vehicles with no current policy. */
export function InsuranceRequirementsPage() {
  const { data, loading, error } = useApi<{ data: { cases: { id: string; label: string; plateNumber: string; projectName: string | null; stage: string; missing: string[] }[]; vehiclesWithoutPolicy: { id: string; plateNumber: string; projectName: string | null }[] } }>("/insurance-center/requirements");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const { cases, vehiclesWithoutPolicy } = data.data;
  void docLabel;
  return (
    <>
      <PageHeader title={t("ins.nav.requirements")} subtitle={t("ins.req.subtitle")} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("ins.req.cases")} />
          {cases.length === 0 ? <EmptyState icon="check" title={t("ins.req.noCases")} /> : (
            <ul className="divide-y divide-slate-100" data-testid="ins-req-cases">
              {cases.map((c) => (
                <li key={c.id} className="space-y-1 px-4 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2"><Link className="font-semibold text-brand-700 ltr hover:underline" to={`/accidents/${c.id}`}>{c.label}</Link><span className="ltr">{c.plateNumber}</span><span className="text-xs text-slate-500">{c.projectName ?? "—"}</span><Badge tone="amber">{stageLabel(c.stage)}</Badge></p>
                  <ul className="list-disc ps-5 text-xs text-slate-600">{c.missing.map((m) => <li key={m}>{requirementText(m)}</li>)}</ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title={t("ins.req.noPolicy")} />
          {vehiclesWithoutPolicy.length === 0 ? <EmptyState icon="shield" title={t("ins.req.allCovered")} /> : (
            <ul className="divide-y divide-slate-100" data-testid="ins-req-vehicles">
              {vehiclesWithoutPolicy.map((v) => <li key={v.id} className="flex items-center justify-between px-4 py-2.5 text-sm"><Link className="font-semibold text-brand-700 ltr hover:underline" to={`/vehicles/${v.id}`}>{v.plateNumber}</Link><span className="text-xs text-slate-500">{v.projectName ?? "—"}</span></li>)}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
