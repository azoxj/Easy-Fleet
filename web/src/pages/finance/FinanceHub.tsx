import { useState } from "react";
import { Link } from "react-router";
import { Money, ProjectSelect, useProjects } from "../../components/shared";
import { Alert, Badge, Card, CardHeader, EmptyState, Input, Loading, PageHeader, Pagination, StatCard, Tabs } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { t } from "../../i18n";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatMoney } from "../../lib/format";
import { claimStatusLabel, stageLabel } from "../../lib/accidentWorkflow";

export type FinanceOverview = {
  claims: { count: number; amount: string };
  due: { count: number; amount: string };
  overdue: { count: number; amount: string };
  paid: { count: number; amount: string };
  insurance: { approved: string; collected: string; awaiting: string; awaitingCount: number };
  awaitingMe: { invoicesToReview: number; transfersToExecute: number; accidentFiles: number; expensesToApprove: number };
  projects: { projectId: string; name: string; pending: number; dueAmount: string; paidAmount: string }[];
};

/** The finance officer's figures for the projects assigned to them (the server limits every number to those projects). */
export function FinanceOverviewCards() {
  const { data, loading, error } = useApi<{ data: FinanceOverview }>("/finance/overview");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const o = data.data;
  const waiting = o.awaitingMe.invoicesToReview + o.awaitingMe.transfersToExecute + o.awaitingMe.accidentFiles + o.awaitingMe.expensesToApprove;
  return (
    <div className="mb-6 space-y-4" data-testid="finance-overview">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("fin.kpi.claims")} value={o.claims.count} hint={formatMoney(o.claims.amount)} icon="receipt" tone="blue" to="/finance/dues" />
        <StatCard label={t("fin.kpi.due")} value={o.due.count} hint={formatMoney(o.due.amount)} icon="clock" tone="amber" to="/finance/dues" />
        <StatCard label={t("fin.kpi.overdue")} value={o.overdue.count} hint={formatMoney(o.overdue.amount)} icon="alert" tone={o.overdue.count > 0 ? "red" : "gray"} to="/finance/invoices?overdue=true" />
        <StatCard label={t("fin.kpi.paid")} value={o.paid.count} hint={formatMoney(o.paid.amount)} icon="check" tone="green" to="/finance/transfers" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("fin.kpi.insuranceApproved")} value={<Money value={o.insurance.approved} />} icon="shield" tone="violet" to="/finance/accidents?view=dues" />
        <StatCard label={t("fin.kpi.insuranceAwaiting")} value={<Money value={o.insurance.awaiting} />} hint={t("fin.kpi.claimsCount", { count: o.insurance.awaitingCount })} icon="clock" tone="amber" to="/finance/accidents?view=dues" />
        <StatCard label={t("fin.kpi.insuranceCollected")} value={<Money value={o.insurance.collected} />} icon="check" tone="green" to="/finance/accidents?view=collected" />
        <StatCard label={t("fin.kpi.waitingMe")} value={waiting} icon="inbox" tone={waiting > 0 ? "violet" : "gray"} />
      </div>
      {waiting > 0 && (
        <Card>
          <CardHeader title={t("fin.waiting.title")} />
          <ul className="grid grid-cols-1 gap-2 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <li><Link className="text-brand-700 hover:underline" to="/finance/invoices?status=SUBMITTED">{t("fin.waiting.invoices", { count: o.awaitingMe.invoicesToReview })}</Link></li>
            <li><Link className="text-brand-700 hover:underline" to="/finance/invoices?status=TRANSFER_PENDING">{t("fin.waiting.transfers", { count: o.awaitingMe.transfersToExecute })}</Link></li>
            <li><Link className="text-brand-700 hover:underline" to="/finance/accidents?view=review">{t("fin.waiting.accidents", { count: o.awaitingMe.accidentFiles })}</Link></li>
            <li><Link className="text-brand-700 hover:underline" to="/finance/expenses">{t("fin.waiting.expenses", { count: o.awaitingMe.expensesToApprove })}</Link></li>
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Claims and dues per project: how much is claimed, due, overdue and paid, for the projects the officer works on. */
export function FinanceDuesPage() {
  const { data, loading, error } = useApi<{ data: FinanceOverview }>("/finance/overview");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const o = data.data;
  return (
    <>
      <PageHeader title={t("fin.nav.dues")} subtitle={t("fin.dues.subtitle")} />
      <FinanceOverviewCards />
      <Card>
        <CardHeader title={t("fin.dues.perProject")} />
        {o.projects.length === 0 ? <EmptyState icon="folder" title={t("fin.noProjects")} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-2 text-start">{t("common.project")}</th><th className="px-4 py-2 text-start">{t("fin.dues.open")}</th><th className="px-4 py-2 text-start">{t("fin.kpi.due")}</th><th className="px-4 py-2 text-start">{t("fin.kpi.paid")}</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {o.projects.map((p) => (
                  <tr key={p.projectId}>
                    <td className="px-4 py-2.5 font-medium"><Link className="text-brand-700 hover:underline" to={`/finance/invoices?projectId=${p.projectId}`}>{p.name}</Link></td>
                    <td className="px-4 py-2.5">{p.pending}</td>
                    <td className="px-4 py-2.5"><Money value={p.dueAmount} /></td>
                    <td className="px-4 py-2.5"><Money value={p.paidAmount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

type AccRow = { id: string; label: string; plateNumber: string; projectName: string | null; stage: string; repairCost: string | null; claimStatus: string | null; claimedAmount: string | null; approvedAmount: string | null; receivedAmount: string | null; lastReview: string | null; canOpen: boolean };

/** The financial side of accidents and insurance claims, per project. */
export function FinanceAccidentsPage() {
  const projects = useProjects();
  const [view, setView] = useState(new URLSearchParams(location.search).get("view") ?? "all");
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<AccRow>>("/finance/accident-finance", { view, projectId: projectId || undefined, q: q.trim() || undefined, page });
  const tabs = [{ key: "all", label: t("fin.acc.all") }, { key: "review", label: t("fin.acc.review") }, { key: "dues", label: t("fin.acc.dues") }, { key: "collected", label: t("fin.acc.collected") }];
  return (
    <>
      <PageHeader title={t("fin.nav.accidents")} subtitle={t("fin.acc.subtitle")} />
      <Card>
        <div className="space-y-3 border-b border-slate-100 px-4 py-3">
          <Tabs tabs={tabs} active={view} onChange={(k) => { setView(k); setPage(1); }} />
          <div className="flex flex-wrap gap-2">
            <Input className="max-w-xs" placeholder={t("accidentFlow.board.search")} aria-label={t("accidentFlow.board.search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            {projects.length > 1 && <ProjectSelect value={projectId} onChange={(v) => { setProjectId(v); setPage(1); }} projects={projects} />}
          </div>
        </div>
        {loading && !data ? <Loading /> : error || !data ? <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert> : data.data.length === 0 ? <EmptyState icon="alert" title={t("accidentFlow.board.empty")} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="fin-accidents">
                <thead className="bg-slate-50 text-xs text-slate-500"><tr>{["accidents.accident", "common.project", "common.status", "fin.acc.repairCost", "fin.acc.claimed", "fin.acc.approved", "fin.acc.received", "fin.acc.review2"].map((k) => <th key={k} className="px-3 py-2 text-start whitespace-nowrap">{t(k as never)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.data.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.canOpen ? <Link className="font-semibold text-brand-700 ltr hover:underline" to={`/accidents/${r.id}`}>{r.label}</Link> : <span className="font-semibold ltr">{r.label}</span>} <span className="text-xs text-slate-500 ltr">{r.plateNumber}</span></td>
                      <td className="px-3 py-2.5">{r.projectName ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.claimStatus ? <Badge tone={r.claimStatus === "COMPENSATION_RECEIVED" ? "green" : r.claimStatus === "REJECTED" ? "red" : "amber"} dot>{claimStatusLabel(r.claimStatus)}</Badge> : <span className="text-xs text-slate-500">{stageLabel(r.stage)}</span>}</td>
                      <td className="px-3 py-2.5"><Money value={r.repairCost} /></td>
                      <td className="px-3 py-2.5"><Money value={r.claimedAmount} /></td>
                      <td className="px-3 py-2.5"><Money value={r.approvedAmount} /></td>
                      <td className="px-3 py-2.5"><Money value={r.receivedAmount} /></td>
                      <td className="px-3 py-2.5">{r.lastReview ? <Badge tone={r.lastReview === "CONFIRMED" ? "green" : "amber"}>{r.lastReview === "CONFIRMED" ? t("fin.acc.confirmed") : t("fin.acc.returned")}</Badge> : "—"}</td>
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

type TrRow = { kind: "INVOICE" | "INSURANCE"; id: string; date: string; amount: string; reference: string | null; projectName: string | null; subject: string; by: string | null; link: string | null };

/** Payments out with their receipts, and insurance transfers confirmed with their proofs. */
export function FinanceTransfersPage() {
  const projects = useProjects();
  const [kind, setKind] = useState("");
  const [projectId, setProjectId] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<TrRow> & { totals: { out: string; in: string } }>("/finance/transfers", { kind: kind || undefined, projectId: projectId || undefined, page });
  const tabs = [{ key: "", label: t("fin.tr.all") }, { key: "INVOICE", label: t("fin.tr.out") }, { key: "INSURANCE", label: t("fin.tr.in") }];
  return (
    <>
      <PageHeader title={t("fin.nav.transfers")} subtitle={t("fin.tr.subtitle")} />
      {data && (
        <div className="mb-4 grid grid-cols-2 gap-4">
          <StatCard label={t("fin.tr.totalOut")} value={<Money value={data.totals.out} />} icon="receipt" tone="amber" />
          <StatCard label={t("fin.tr.totalIn")} value={<Money value={data.totals.in} />} icon="check" tone="green" />
        </div>
      )}
      <Card>
        <div className="space-y-3 border-b border-slate-100 px-4 py-3">
          <Tabs tabs={tabs} active={kind} onChange={(k) => { setKind(k); setPage(1); }} />
          {projects.length > 1 && <div className="flex gap-2"><ProjectSelect value={projectId} onChange={(v) => { setProjectId(v); setPage(1); }} projects={projects} /></div>}
        </div>
        {loading && !data ? <Loading /> : error || !data ? <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert> : data.data.length === 0 ? <EmptyState icon="receipt" title={t("fin.tr.none")} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="fin-transfers">
                <thead className="bg-slate-50 text-xs text-slate-500"><tr>{["fin.tr.kind", "common.date", "fin.tr.subject", "common.project", "fin.tr.amount", "fin.tr.reference", "fin.tr.by"].map((k) => <th key={k} className="px-3 py-2 text-start whitespace-nowrap">{t(k as never)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.data.map((r) => (
                    <tr key={`${r.kind}-${r.id}`}>
                      <td className="px-3 py-2.5"><Badge tone={r.kind === "INVOICE" ? "amber" : "green"} dot>{r.kind === "INVOICE" ? t("fin.tr.out") : t("fin.tr.in")}</Badge></td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(r.date)}</td>
                      <td className="px-3 py-2.5">{r.link ? <Link className="text-brand-700 ltr hover:underline" to={r.link}>{r.subject}</Link> : <span className="ltr">{r.subject}</span>}</td>
                      <td className="px-3 py-2.5">{r.projectName ?? "—"}</td>
                      <td className="px-3 py-2.5"><Money value={r.amount} /></td>
                      <td className="px-3 py-2.5 ltr">{r.reference ?? "—"}</td>
                      <td className="px-3 py-2.5">{r.by ?? "—"}</td>
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

/** Maintenance, fuel and violation costs of the officer's projects: shortcuts to the screens that hold the original records. */
export function FinanceCostsPage() {
  const { can } = useAuth();
  const items = [
    { to: "/maintenance", label: t("common.maintenance"), hint: t("fin.costs.maintenance"), perm: "maintenance.read", icon: "wrench" },
    { to: "/fuel", label: t("common.fuel"), hint: t("fin.costs.fuel"), perm: "fuel.read", icon: "fuel" },
    { to: "/violations", label: t("common.violations"), hint: t("fin.costs.violations"), perm: "violations.read", icon: "ticket" },
    { to: "/finance/expenses", label: t("common.expenses"), hint: t("fin.costs.expenses"), perm: "finance.read", icon: "copy" },
  ].filter((i) => can(i.perm));
  return (
    <>
      <PageHeader title={t("fin.nav.costs")} subtitle={t("fin.costs.subtitle")} />
      <FinanceOverviewCards />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((i) => <Link key={i.to} to={i.to}><Card><div className="p-4"><p className="font-semibold text-slate-900">{i.label}</p><p className="mt-1 text-xs leading-5 text-slate-500">{i.hint}</p></div></Card></Link>)}
      </div>
    </>
  );
}
