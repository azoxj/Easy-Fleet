import { useState } from "react";
import { Link } from "react-router";
import { useConfirm, useToast } from "../../components/feedback";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { HANDOVER_STATUS, VEHICLE_STATUS } from "../../lib/labels";
import type { Project } from "../../lib/types";
import { errorMessage } from "../../lib/forms";
import { t } from "../../i18n";

type DriverRow = {
  id: string;
  fullName: string;
  employeeNumber: string;
  projectId: string | null;
  projectName: string | null;
  driverStatus: string;
  link: { status: "ACTIVE" | "REVOKED"; createdAt: string; rotatedAt: string | null; lastAccessAt: string | null; accessCount: number } | null;
  custody: { sessionId: string; status: string; plateNumber: string; handoverAt: string | null; viaPortal: boolean } | null;
};
type ProjectVehicle = { id: string; plateNumber: string; make: string; model: string; status: string; state: "AVAILABLE" | "OCCUPIED" | "UNAVAILABLE"; driverName: string | null; sessionId: string | null; sessionStatus: string | null; since: string | null };
type RecentRow = { id: string; plateNumber: string; driverName: string | null; projectName: string | null; status: string; handoverAt: string | null; returnAt: string | null; viaPortal: boolean };

/**
 * Admin side of the driver portal: create / copy / renew / revoke each driver's permanent link, see who holds what,
 * the available and occupied vehicles of every project, and the latest pickups and returns. The exceptional
 * administrative return lives on the handover detail page (it asks for a reason and is audited).
 */
export function DriverPortalAdminPage() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<{ name: string; link: string; renewed: boolean } | null>(null);
  const [vehiclesProject, setVehiclesProject] = useState("");
  const canManage = can("handover.manage");

  const drivers = useApi<Paged<DriverRow>>("/driver-portal/drivers", { q, projectId, page, pageSize: 20 });
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const vehicles = useApi<{ data: ProjectVehicle[]; meta: { project: string; available: number; occupied: number; unavailable: number } }>(vehiclesProject ? `/driver-portal/projects/${vehiclesProject}/vehicles` : null);
  const recent = useApi<Paged<RecentRow>>("/handovers", { pageSize: 10 });

  const issue = async (d: DriverRow) => {
    if (d.link?.status === "ACTIVE" && !(await confirm({ title: t("driverPortalAdmin.renewTitle"), message: t("driverPortalAdmin.renewMessage", { name: d.fullName }) }))) return;
    setBusy(d.id);
    try {
      const r = await api<{ data: { link: string; renewed: boolean } }>(`/driver-portal/drivers/${d.id}/link`, { method: "POST" });
      setShown({ name: d.fullName, link: r.data.link, renewed: r.data.renewed });
      drivers.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (d: DriverRow) => {
    if (!(await confirm({ title: t("driverPortalAdmin.revokeTitle"), message: t("driverPortalAdmin.revokeMessage", { name: d.fullName }), danger: true }))) return;
    setBusy(d.id);
    try {
      await api(`/driver-portal/drivers/${d.id}/link/revoke`, { method: "POST" });
      toast.success(t("driverPortalAdmin.revoked"));
      drivers.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t("handover.linkCopied"));
    } catch {
      toast.error(t("handover.couldNotCopyLink"));
    }
  };

  const rows = drivers.data?.data ?? [];
  return (
    <>
      <PageHeader title={t("driverPortalAdmin.title")} subtitle={t("driverPortalAdmin.subtitle")} />
      <Card className="mb-6 p-4">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input placeholder={t("driverPortalAdmin.search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select value={projectId} onChange={(e) => { setProjectId(e.target.value); setPage(1); }} aria-label={t("common.project")}>
            <option value="">{t("common.allProjects")}</option>
            {projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        {drivers.loading && !drivers.data ? <Loading /> : rows.length === 0 ? <EmptyState icon="user" title={t("driverPortalAdmin.noDrivers")} /> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>{[t("common.driver"), t("common.project"), t("driverPortalAdmin.custody"), t("driverPortalAdmin.link"), ""].map((h, i) => <th key={i} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="px-3 py-2"><p className="font-medium">{d.fullName}</p><p className="text-xs text-slate-500" dir="ltr">{d.employeeNumber}</p></td>
                    <td className="px-3 py-2">{d.projectName ?? <span className="text-amber-700">{t("driverPortalAdmin.noProject")}</span>}</td>
                    <td className="px-3 py-2">
                      {d.custody ? (
                        <Link to={`/handovers/${d.custody.sessionId}`} className="text-brand-700 hover:underline"><span dir="ltr">{d.custody.plateNumber}</span> · <StatusBadge map={HANDOVER_STATUS} value={d.custody.status} /></Link>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      {d.link ? (
                        <div className="space-y-0.5">
                          {d.link.status === "ACTIVE" ? <Badge tone="green" dot>{t("handover.linkActive")}</Badge> : <Badge tone="gray" dot>{t("handover.linkClosed")}</Badge>}
                          <p className="text-xs text-slate-500">{d.link.lastAccessAt ? t("driverPortalAdmin.lastAccess", { at: formatDateTime(d.link.lastAccessAt), n: d.link.accessCount }) : t("driverPortalAdmin.neverOpened")}</p>
                        </div>
                      ) : <span className="text-slate-400">{t("driverPortalAdmin.noLink")}</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-end">
                      {canManage && (
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" className="px-2.5 py-1 text-xs" loading={busy === d.id} onClick={() => void issue(d)}>{!d.link ? t("driverPortalAdmin.create") : d.link.status === "ACTIVE" ? t("driverPortalAdmin.renew") : t("driverPortalAdmin.reopen")}</Button>
                          {d.link?.status === "ACTIVE" && <Button variant="ghost" className="px-2.5 py-1 text-xs" disabled={busy === d.id} onClick={() => void revoke(d)}>{t("driverPortalAdmin.revoke")}</Button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {drivers.data && <Pagination page={page} pageSize={20} total={drivers.data.meta.total} onPage={setPage} />}
      </Card>

      <Card className="mb-6 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-bold">{t("driverPortalAdmin.projectVehicles")}</h2>
          <Select value={vehiclesProject} onChange={(e) => setVehiclesProject(e.target.value)} aria-label={t("common.project")} className="max-w-xs">
            <option value="">{t("driverPortalAdmin.chooseProject")}</option>
            {projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        {!vehiclesProject ? <p className="text-sm text-slate-500">{t("driverPortalAdmin.chooseProjectHint")}</p> : vehicles.loading && !vehicles.data ? <Loading /> : vehicles.data && (
          <>
            <div className="mb-3 flex flex-wrap gap-2 text-sm">
              <Badge tone="green">{t("driverPortalAdmin.availableCount", { n: vehicles.data.meta.available })}</Badge>
              <Badge tone="amber">{t("driverPortalAdmin.occupiedCount", { n: vehicles.data.meta.occupied })}</Badge>
              <Badge tone="gray">{t("driverPortalAdmin.unavailableCount", { n: vehicles.data.meta.unavailable })}</Badge>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500"><tr>{[t("common.plateNumber"), t("common.vehicle"), t("common.status"), t("driverPortalAdmin.heldBy"), t("driverPortalAdmin.since")].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {vehicles.data.data.map((v) => (
                    <tr key={v.id}>
                      <td className="px-3 py-2 font-medium" dir="ltr">{v.plateNumber}</td>
                      <td className="px-3 py-2">{v.make} {v.model}</td>
                      <td className="px-3 py-2">{v.state === "AVAILABLE" ? <Badge tone="green" dot>{t("driverPortal.available")}</Badge> : v.state === "OCCUPIED" ? <Badge tone="amber" dot>{t("driverPortalAdmin.occupied")}</Badge> : <Badge tone="gray" dot>{VEHICLE_STATUS[v.status]?.label ?? v.status}</Badge>}</td>
                      <td className="px-3 py-2">{v.sessionId ? <Link to={`/handovers/${v.sessionId}`} className="text-brand-700 hover:underline">{v.driverName ?? "—"}</Link> : (v.driverName ?? "—")}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{v.since ? formatDateTime(v.since) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold">{t("driverPortalAdmin.recent")}</h2>
          <Link to="/handovers" className="text-sm font-medium text-brand-700 hover:underline">{t("driverPortalAdmin.allOperations")}</Link>
        </div>
        {recent.data && recent.data.data.length === 0 ? <p className="text-sm text-slate-500">{t("driverPortalAdmin.noOperations")}</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {recent.data?.data.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-medium"><Link to={`/handovers/${r.id}`} className="text-brand-700 hover:underline" dir="ltr">{r.plateNumber}</Link></td>
                    <td className="px-3 py-2">{r.driverName ?? "—"}</td>
                    <td className="px-3 py-2"><StatusBadge map={HANDOVER_STATUS} value={r.status} /> {r.viaPortal && <Badge tone="blue">{t("driverPortalAdmin.viaPortal")}</Badge>}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{formatDateTime(r.returnAt ?? r.handoverAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!shown} onClose={() => setShown(null)} title={shown?.renewed ? t("driverPortalAdmin.linkRenewedTitle") : t("driverPortalAdmin.linkCreatedTitle")} footer={<><Button variant="secondary" onClick={() => setShown(null)}>{t("common.close")}</Button><Button icon="copy" onClick={() => shown && void copy(shown.link)}>{t("driverPortalAdmin.copyLink")}</Button></>}>
        <div className="space-y-3">
          <Alert tone="amber">{t("driverPortalAdmin.shownOnce")}</Alert>
          <Field label={shown?.name ?? ""} htmlFor="portal-link"><Input id="portal-link" readOnly dir="ltr" value={shown?.link ?? ""} onFocus={(e) => e.currentTarget.select()} /></Field>
        </div>
      </Modal>
    </>
  );
}
