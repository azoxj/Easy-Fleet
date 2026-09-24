import { useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Button, Card, EmptyState, Loading, PageHeader, Pagination, cx } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { api, type Paged } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { NotificationItem } from "../lib/types";

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi<Paged<NotificationItem>>("/notifications", { unreadOnly: unreadOnly ? "true" : undefined, page, pageSize: 20 });

  const open = async (n: NotificationItem) => {
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    if (n.link && n.link.startsWith("/") && !n.link.startsWith("//")) navigate(n.link);
    else reload();
  };

  return (
    <>
      <PageHeader
        title="الإشعارات"
        actions={
          <>
            <Button variant="secondary" onClick={() => { setUnreadOnly((u) => !u); setPage(1); }}>{unreadOnly ? "عرض الكل" : "غير المقروءة فقط"}</Button>
            <Button variant="secondary" icon="check" onClick={() => void api("/notifications/read-all", { method: "POST" }).then(reload)}>تعليم الكل كمقروء</Button>
          </>
        }
      />
      <Card>
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
                      <span className="mt-1 block text-xs text-slate-400">{formatDateTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
