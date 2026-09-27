import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ExpiryBadge } from "../../components/common";
import { DataList } from "../../components/DataList";
import { FilterBar, ProjectSelect, useProjects } from "../../components/shared";
import { Alert, Card, EmptyState, Loading, PageHeader, Pagination, Select, StatCard } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import type { Paged } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { DOC_KIND, DOCUMENT_TYPE, EMPLOYEE_DOC_TYPE } from "../../lib/labels";
import type { ExpiryStatus } from "../../lib/types";
import { t } from "../../i18n";

type DocRow = { kind: string; id: string; type: string; number: string | null; expiryDate: string | null; ownerId: string; ownerName: string; projectId: string | null; projectName: string | null; hasFile: boolean; status: string };

const typeLabel = (r: DocRow) => (r.kind === "EMPLOYEE" ? EMPLOYEE_DOC_TYPE[r.type] : r.kind === "LICENSE" ? t("documentsCenter.drivingLicense") : r.kind === "INSURANCE" ? t("documentsCenter.insurance") : DOCUMENT_TYPE[r.type]) ?? r.type;
const ownerLink = (r: DocRow) => (r.kind === "EMPLOYEE" ? `/employees/${r.ownerId}` : r.kind === "LICENSE" ? `/drivers/${r.ownerId}` : `/vehicles/${r.ownerId}`);

export function DocumentsCenterPage() {
  const [params] = useSearchParams();
  const projects = useProjects();
  const initStatus = params.get("status") === "EXPIRING" ? "EXPIRING_SOON" : (params.get("status") ?? "");
  const [f, setF] = useState({ q: "", kind: "", status: initStatus, projectId: "" });
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<DocRow> & { summary: Record<string, number> }>("/documents-center", { ...f, page, pageSize: 25 });
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v).length;
  return (
    <>
      <PageHeader title={t("common.documentCenter")} subtitle={t("documentsCenter.allDocumentsWithAnExpiry")} />
      {data && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <button onClick={() => upd("status", "EXPIRED")} className="text-start"><StatCard label={t("common.expired")} value={data.summary.EXPIRED ?? 0} icon="alert" tone="red" /></button>
          <button onClick={() => upd("status", "EXPIRING_SOON")} className="text-start"><StatCard label={t("common.expiringWithin30Days")} value={data.summary.EXPIRING_SOON ?? 0} icon="clock" tone="amber" /></button>
          <button onClick={() => upd("status", "ACTIVE")} className="text-start"><StatCard label={t("documentsCenter.valid")} value={data.summary.ACTIVE ?? 0} icon="check" tone="green" /></button>
          <button onClick={() => upd("status", "NO_EXPIRY")} className="text-start"><StatCard label={t("documentsCenter.noExpiryDate")} value={data.summary.NO_EXPIRY ?? 0} icon="file" tone="gray" /></button>
        </div>
      )}
      <Card>
        <FilterBar q={f.q} onQ={(v) => upd("q", v)} placeholder={t("documentsCenter.searchPlateEmployeeNameDocument")} active={active} onClear={() => { setF({ q: f.q, kind: "", status: "", projectId: "" }); setPage(1); }}>
          <Select value={f.kind} onChange={(e) => upd("kind", e.target.value)} aria-label={t("common.type")}><option value="">{t("documentsCenter.allTypes")}</option>{Object.entries(DOC_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label={t("common.status")}><option value="">{t("common.allStatuses")}</option><option value="EXPIRED">{t("common.expired")}</option><option value="EXPIRING_SOON">{t("documentsCenter.expiringSoon")}</option><option value="ACTIVE">{t("documentsCenter.valid")}</option><option value="NO_EXPIRY">{t("documentsCenter.noDate")}</option></Select>
          {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
        </FilterBar>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="file" title={t("documentsCenter.noMatchingDocuments")} /> : (
          <>
            <DataList rows={data.data} rowKey={(r) => `${r.kind}-${r.id}`} columns={[
              { header: t("documentsCenter.document"), primary: true, cell: (r) => <span>{typeLabel(r)}{r.number && <span className="ms-2 text-slate-500 ltr">{r.number}</span>}</span> },
              { header: t("documentsCenter.owner"), cell: (r) => <Link to={ownerLink(r)} className="text-brand-700 hover:underline">{r.ownerName}</Link> },
              { header: t("common.category"), cell: (r) => DOC_KIND[r.kind], hideOnMobile: true },
              { header: t("common.project"), cell: (r) => r.projectName ?? "—", hideOnMobile: true },
              { header: t("common.expiry"), cell: (r) => formatDate(r.expiryDate) },
              { header: t("common.status"), cell: (r) => (r.status === "NO_EXPIRY" ? <span className="text-xs text-slate-400">{t("documentsCenter.noDate")}</span> : <ExpiryBadge status={r.status as ExpiryStatus} />) },
              { header: t("documentsCenter.attachment"), cell: (r) => (r.hasFile ? "✓" : "—"), hideOnMobile: true },
            ]} />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
