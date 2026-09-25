import { useState } from "react";
import { Link } from "react-router";
import { Money } from "../../components/shared";
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge, cx } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { timeAgo } from "../../lib/format";
import { APPROVAL_KIND } from "../../lib/labels";

type Item = { kind: string; id: string; label: string; title: string; projectName: string | null; amount: string | null; requestedBy: string | null; since: string; link: string };

export function ApprovalsPage() {
  const { data, loading, error } = useApi<{ data: Item[]; meta: { total: number; counts: Record<string, number> } }>("/approvals");
  const [kind, setKind] = useState("");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const items = data.data.filter((i) => !kind || i.kind === kind);
  return (
    <>
      <PageHeader title="مركز الاعتمادات" subtitle="كل ما ينتظر قرارك الآن — مرتب من الأقدم" />
      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setKind("")} className={cx("rounded-full px-3 py-1 text-sm", !kind ? "bg-brand-700 text-white" : "bg-white ring-1 ring-slate-200")}>الكل ({data.meta.total})</button>
        {Object.entries(data.meta.counts).map(([k, n]) => (
          <button key={k} onClick={() => setKind(k)} className={cx("rounded-full px-3 py-1 text-sm", kind === k ? "bg-brand-700 text-white" : "bg-white ring-1 ring-slate-200")}>{APPROVAL_KIND[k]?.label ?? k} ({n})</button>
        ))}
      </div>
      <Card>
        {!items.length ? <EmptyState icon="check" title="لا توجد عناصر بانتظارك" description="ستظهر هنا طلبات الاعتماد والمراجعة حسب صلاحياتك" /> : (
          <ul className="divide-y divide-slate-100">
            {items.map((i) => (
              <li key={`${i.kind}-${i.id}`}>
                <Link to={i.link} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50">
                  <StatusBadge map={APPROVAL_KIND} value={i.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-900"><span className="ltr">{i.label}</span> — {i.title}</span>
                    <span className="block text-xs text-slate-500">{i.projectName ?? ""}{i.requestedBy ? ` · ${i.requestedBy}` : ""} · {timeAgo(i.since)}</span>
                  </span>
                  {i.amount && <Money value={i.amount} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
