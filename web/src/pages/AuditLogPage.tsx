import { useState } from "react";
import { Alert, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, Table, Td } from "../components/ui";
import { useApi } from "../hooks/useApi";
import type { Paged } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { AUDIT_ACTION } from "../lib/labels";
import type { AuditRow } from "../lib/types";

const ENTITY: Record<string, string> = { user: "مستخدم", session: "جلسة", project: "مشروع", vehicle: "مركبة", assignment: "إسناد" };

export function AuditLogPage() {
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<AuditRow>>("/audit-logs", { action, entity, from, to, page, pageSize: 30 });
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setPage(1); };

  return (
    <>
      <PageHeader title="سجل التدقيق" subtitle="سجل غير قابل للتعديل أو الحذف لكل العمليات الحساسة" />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={action} onChange={reset(setAction)}>
            <option value="">كل العمليات</option>
            {Object.entries(AUDIT_ACTION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Select value={entity} onChange={reset(setEntity)}>
            <option value="">كل الكيانات</option>
            {Object.entries(ENTITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Input type="date" value={from} onChange={reset(setFrom)} aria-label="من تاريخ" />
          <Input type="date" value={to} onChange={reset(setTo)} aria-label="إلى تاريخ" />
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="log" title="لا توجد سجلات" /> : (
          <>
            <Table head={["الوقت", "المستخدم", "العملية", "الكيان", "التفاصيل", "IP"]}>
              {data.data.map((r) => (
                <tr key={r.id} className="align-top">
                  <Td className="text-xs">{formatDateTime(r.createdAt)}</Td>
                  <Td>{r.userName ?? <span className="text-slate-400">—</span>}</Td>
                  <Td className="font-medium">{AUDIT_ACTION[r.action] ?? r.action}</Td>
                  <Td>{ENTITY[r.entity] ?? r.entity}</Td>
                  <Td className="max-w-md whitespace-normal">
                    {r.metadata ? <code className="block max-h-24 overflow-auto rounded bg-slate-50 p-2 text-[11px] break-all text-slate-600 ltr">{JSON.stringify(r.metadata)}</code> : "—"}
                  </Td>
                  <Td className="text-xs text-slate-500"><span className="ltr">{r.ip ?? "—"}</span></Td>
                </tr>
              ))}
            </Table>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
