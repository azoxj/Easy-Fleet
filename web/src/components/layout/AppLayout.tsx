import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { timeAgo } from "../../lib/format";
import { NAV_GROUPS, visibleNav } from "../../lib/permissions";
import type { NotificationItem } from "../../lib/types";
import { Icon } from "../icons";
import { cx } from "../ui";

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2">
      <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white shadow-sm">
        <Icon name="truck" className="size-5" />
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-bold text-white">إيزي فليت</span>
        <span className="block text-[11px] tracking-wide text-slate-400 ltr">Easy Fleet</span>
      </span>
    </Link>
  );
}

function Sidebar({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) {
  const { me } = useAuth();
  return (
    <nav className="flex min-h-full flex-col bg-ink-950 px-3 pt-4 pb-5" aria-label="القائمة الرئيسية">
      <div className="flex items-center justify-between gap-2 pb-2">
        <Brand />
        {onClose && (
          <button onClick={onClose} className="grid size-11 place-items-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white active:bg-white/15" aria-label="إغلاق القائمة">
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-5">
        {NAV_GROUPS.map((g) => {
          const items = visibleNav(me, g.items);
          if (!items.length) return null;
          return (
            <section key={g.title} aria-labelledby={`nav-${g.title}`}>
              <h2 id={`nav-${g.title}`} className="mb-1.5 px-3 text-[11px] font-semibold tracking-wide text-slate-400">{g.title}</h2>
              <ul className="space-y-1">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      end={i.to === "/" || i.to === "/finance"}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cx(
                          "group relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition select-none",
                          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-400",
                          isActive
                            ? "bg-brand-500/15 font-semibold text-white ring-1 ring-inset ring-brand-400/25 before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-full before:bg-brand-400"
                            : "font-medium text-slate-300 hover:bg-white/[0.07] hover:text-white active:bg-white/[0.12]",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon name={i.icon} className={cx("size-[18px] shrink-0 transition", isActive ? "text-brand-300" : "text-slate-400 group-hover:text-slate-200")} />
                          <span className="truncate">{i.label}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="mt-auto px-3 pt-6 text-[11px] text-slate-500">نظام داخلي — الإصدار 1.0</p>
    </nav>
  );
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOut();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, onOut]);
}

type SearchResult = {
  vehicles: { id: string; plateNumber: string; plateArabic: string | null; make: string; model: string }[];
  projects: { id: string; name: string; code: string }[];
  employees: { id: string; fullName: string; employeeNumber: string; jobTitle: string | null }[];
  drivers: { id: string; fullName: string; licenseNumber: string | null }[];
  maintenance: { id: string; label: string; issue: string; plateNumber: string }[];
  invoices: { id: string; label: string; description: string | null; total: string }[];
  documents: { id: string; vehicleId: string; plateNumber: string; kind: string; documentNumber?: string | null; policyNumber?: string; provider?: string }[];
};

type Hit = { key: string; icon: string; to: string; main: string; sub?: string; ltr?: boolean };

function hitsOf(r: SearchResult): { title: string; items: Hit[] }[] {
  return [
    { title: "المركبات", items: r.vehicles.map((v) => ({ key: v.id, icon: "truck", to: `/vehicles/${v.id}`, main: v.plateNumber, sub: `${v.plateArabic ?? ""} ${v.make} ${v.model}`.trim(), ltr: true })) },
    { title: "المشاريع", items: r.projects.map((p) => ({ key: p.id, icon: "folder", to: `/projects/${p.id}`, main: p.name, sub: p.code })) },
    { title: "الموظفون", items: (r.employees ?? []).map((e) => ({ key: e.id, icon: "id", to: `/employees/${e.id}`, main: e.fullName, sub: e.employeeNumber })) },
    { title: "السائقون", items: (r.drivers ?? []).map((d) => ({ key: d.id, icon: "user", to: `/drivers/${d.id}`, main: d.fullName, sub: d.licenseNumber ?? "" })) },
    { title: "الصيانة", items: (r.maintenance ?? []).map((m) => ({ key: m.id, icon: "wrench", to: `/maintenance/${m.id}`, main: m.label, sub: `${m.plateNumber} — ${m.issue}` })) },
    { title: "الفواتير", items: (r.invoices ?? []).map((i) => ({ key: i.id, icon: "receipt", to: `/finance/invoices/${i.id}`, main: i.label, sub: i.description ?? i.total })) },
    { title: "المستندات", items: (r.documents ?? []).map((d) => ({ key: d.id, icon: "file", to: `/vehicles/${d.vehicleId}`, main: d.documentNumber ?? d.policyNumber ?? "", sub: `${d.kind === "INSURANCE" ? `تأمين ${d.provider ?? ""}` : "مستند"} — ${d.plateNumber}` })) },
  ].filter((g) => g.items.length > 0);
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useClickOutside(box, () => setOpen(false));

  useEffect(() => {
    if (q.trim().length < 2) {
      setRes(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ data: SearchResult }>("/search", { query: { q: q.trim() }, signal: ctrl.signal })
        .then((r) => {
          setRes(r.data);
          setOpen(true);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (path: string) => {
    setOpen(false);
    setQ("");
    navigate(path);
  };
  const groups = res ? hitsOf(res) : [];

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => res && setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="بحث: لوحة، موظف، سائق، MR-، INV-، مستند..."
        aria-label="بحث شامل"
        className="w-full rounded-lg border-0 bg-slate-100 py-2 ps-9 pe-3 text-sm placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-brand-600"
      />
      {open && res && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {groups.length === 0 && <p className="px-4 py-3 text-sm text-slate-500">لا توجد نتائج</p>}
          {groups.map((g) => (
            <div key={g.title}>
              <p className="bg-slate-50 px-4 py-1.5 text-xs font-semibold text-slate-500">{g.title}</p>
              {g.items.map((h) => (
                <button key={h.key} onClick={() => go(h.to)} className="flex w-full items-center gap-3 px-4 py-2 text-start text-sm hover:bg-slate-50">
                  <Icon name={h.icon} className="size-4 shrink-0 text-slate-400" />
                  <span className={`font-medium ${h.ltr ? "ltr" : ""}`}>{h.main}</span>
                  {h.sub && <span className="truncate text-slate-500">{h.sub}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useClickOutside(box, () => setOpen(false));

  const refreshCount = () =>
    api<{ data: { count: number } }>("/notifications/unread-count")
      .then((r) => setCount(r.data.count))
      .catch(() => undefined);

  useEffect(() => {
    void refreshCount();
    const t = setInterval(() => void refreshCount(), 60_000);
    return () => clearInterval(t);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const r = await api<{ data: NotificationItem[] }>("/notifications", { query: { pageSize: 8 } }).catch(() => null);
      setItems(r?.data ?? []);
    }
  };

  const openItem = async (n: NotificationItem) => {
    if (!n.readAt) {
      await api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
      void refreshCount();
    }
    setOpen(false);
    // Links are validated server-side as in-app paths; guard again client-side.
    if (n.link && n.link.startsWith("/") && !n.link.startsWith("//")) navigate(n.link);
  };

  return (
    <div ref={box} className="relative">
      <button onClick={toggle} className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label={`الإشعارات (${count} غير مقروء)`}>
        <Icon name="bell" />
        {count > 0 && (
          <span className="absolute -top-0.5 -end-0.5 grid min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{count > 99 ? "99+" : count}</span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold">الإشعارات</p>
            <Link to="/notifications" onClick={() => setOpen(false)} className="text-xs font-medium text-brand-700 hover:underline">
              عرض الكل
            </Link>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items === null && <p className="px-4 py-6 text-center text-sm text-slate-500">جارٍ التحميل...</p>}
            {items?.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">لا توجد إشعارات</p>}
            {items?.map((n) => (
              <button key={n.id} onClick={() => void openItem(n)} className={cx("flex w-full gap-3 border-b border-slate-50 px-4 py-3 text-start hover:bg-slate-50", !n.readAt && "bg-brand-50/50")}>
                <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-brand-600")} />
                <span className="min-w-0">
                  <span className="block text-sm text-slate-800">{n.title}</span>
                  <span className="mt-0.5 block text-xs text-slate-400">{timeAgo(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useClickOutside(box, () => setOpen(false));
  if (!me) return null;
  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-slate-100" aria-haspopup="menu" aria-expanded={open}>
        <span className="grid size-8 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">{me.name.trim().charAt(0)}</span>
        <span className="hidden text-start sm:block">
          <span className="block max-w-40 truncate text-sm font-medium text-slate-800">{me.name}</span>
          <span className="block max-w-40 truncate text-xs text-slate-500 ltr">{me.email}</span>
        </span>
      </button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg" role="menu">
          <Link to="/account/password" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" role="menuitem">
            <Icon name="lock" className="size-4" /> تغيير كلمة المرور
          </Link>
          <button
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            role="menuitem"
          >
            <Icon name="logout" className="size-4" /> تسجيل الخروج
          </button>
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  useEffect(() => setDrawer(false), [location.pathname]);
  // Mobile drawer: Escape closes it and the page behind does not scroll.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [drawer]);

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto bg-ink-950 lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-[1100] lg:hidden" role="dialog" aria-modal="true" aria-label="القائمة الرئيسية">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-[1px]" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw] overflow-y-auto overscroll-contain bg-ink-950 shadow-2xl pb-[env(safe-area-inset-bottom)]">
            <Sidebar onNavigate={() => setDrawer(false)} onClose={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:gap-3 sm:px-6">
          <button onClick={() => setDrawer(true)} className="grid size-11 shrink-0 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 active:bg-slate-200 lg:hidden" aria-label="فتح القائمة" aria-expanded={drawer}>
            <Icon name="menu" />
          </button>
          <GlobalSearch />
          <div className="ms-auto flex items-center gap-1">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
