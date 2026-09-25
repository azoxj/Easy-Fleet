import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useProjects, ProjectSelect } from "../components/shared";
import { useToast } from "../components/feedback";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, Textarea, cx } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { api, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { errorMessage } from "../lib/forms";
import { NOTIFICATION_CATEGORY } from "../lib/labels";
import type { NotificationItem } from "../lib/types";

function BroadcastModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const projects = useProjects();
  const [v, setV] = useState({ title: "", body: "", projectId: "" });
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ data: { recipients: number } }>("/notifications/broadcast", { method: "POST", body: { title: v.title, ...(v.body.trim() ? { body: v.body.trim() } : {}), ...(v.projectId ? { projectId: v.projectId } : {}) } });
      toast.success(`تم الإرسال إلى ${r.data.recipients} مستخدم`);
      setV({ title: "", body: "", projectId: "" });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="إرسال إشعار عام" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button loading={busy} onClick={send}>إرسال</Button></>}>
      <div className="space-y-4">
        <Field label="العنوان" required htmlFor="bc-title"><Input id="bc-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="النص" htmlFor="bc-body"><Textarea id="bc-body" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
        <Field label="المستلمون" htmlFor="bc-project"><ProjectSelect id="bc-project" value={v.projectId} onChange={(x) => setV({ ...v, projectId: x })} projects={projects} all={can("notifications.manage", "ALL") ? "جميع المستخدمين" : "اختر المشروع..."} /></Field>
      </div>
    </Modal>
  );
}

export function NotificationsPage() {
  const { can } = useAuth();
  const [state, setState] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [broadcast, setBroadcast] = useState(false);
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi<Paged<NotificationItem & { category?: string }>>("/notifications", { state, category, page, pageSize: 20 });

  const open = async (n: NotificationItem) => {
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    if (n.link && n.link.startsWith("/") && !n.link.startsWith("//")) navigate(n.link);
    else reload();
  };

  return (
    <>
      <PageHeader
        title="مركز الإشعارات"
        actions={
          <>
            {can("notifications.manage") && <Button variant="secondary" icon="bell" onClick={() => setBroadcast(true)}>إشعار عام</Button>}
            <Button variant="secondary" icon="check" onClick={() => void api("/notifications/read-all", { method: "POST" }).then(reload)}>تعليم الكل كمقروء</Button>
            <Link to="/settings?tab=notifications" className="inline-flex items-center rounded-lg px-3 py-2 text-sm text-brand-700 hover:bg-brand-50">التفضيلات</Link>
          </>
        }
      />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-3">
          <Select value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} aria-label="الحالة"><option value="">الكل</option><option value="unread">غير المقروءة</option><option value="read">المقروءة</option></Select>
          <Select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} aria-label="الفئة"><option value="">كل الفئات</option>{Object.entries(NOTIFICATION_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="bell" title="لا توجد إشعارات" /> : (
          <>
            <ul className="divide-y divide-slate-100">
              {data.data.map((n) => (
                <li key={n.id}>
                  <button onClick={() => void open(n)} className={cx("flex w-full items-start gap-3 px-5 py-4 text-start hover:bg-slate-50", !n.readAt && "bg-brand-50/40")}>
                    <span className={cx("mt-2 size-2 shrink-0 rounded-full", n.readAt ? "bg-slate-200" : "bg-brand-600")} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-800">{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-sm text-slate-600">{n.body}</span>}
                      <span className="mt-1 flex items-center gap-2 text-xs text-slate-400">{n.category && <Badge tone="slate">{NOTIFICATION_CATEGORY[n.category] ?? n.category}</Badge>}{formatDateTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <BroadcastModal open={broadcast} onClose={() => { setBroadcast(false); reload(); }} />
    </>
  );
}
