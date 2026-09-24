import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { timeAgo } from "../../lib/format";
import { NAV, UPCOMING_NAV, visibleNav } from "../../lib/permissions";
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

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me } = useAuth();
  const items = visibleNav(me, NAV);
  return (
    <nav className="flex h-full flex-col gap-6 bg-ink-950 px-3 py-5" aria-label="القائمة الرئيسية">
      <Brand />
      <ul className="space-y-0.5">
        {items.map((i) => (
          <li key={i.to}>
            <NavLink
              to={i.to}
              end={i.to === "/"}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-brand-700 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white",
                )
              }
            >
              <Icon name={i.icon} className="size-[18px]" />
              {i.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div>
        <p className="mb-2 px-3 text-[11px] font-semibold tracking-wider text-slate-500">وحدات قادمة</p>
        <ul className="space-y-0.5">
          {UPCOMING_NAV.map((i) => (
            <li key={i.label} className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-1.5 text-sm text-slate-500" aria-disabled="true">
              <Icon name={i.icon} className="size-[18px]" />
              <span className="flex-1">{i.label}</span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px]">قريبًا</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-auto px-3 text-[11px] text-slate-600">نظام داخلي — الإصدار 0.1</p>
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

type SearchResult = { vehicles: { id: string; plateNumber: string; make: string; model: string }[]; projects: { id: string; name: string; code: string }[] };

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
  const empty = res && res.vehicles.length === 0 && res.projects.length === 0;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => res && setOpen(true)}
        placeholder="ابحث برقم اللوحة أو اسم المشروع..."
        aria-label="بحث"
        className="w-full rounded-lg border-0 bg-slate-100 py-2 ps-9 pe-3 text-sm placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-brand-600"
      />
      {open && res && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          {empty && <p className="px-4 py-3 text-sm text-slate-500">لا توجد نتائج</p>}
          {res.vehicles.length > 0 && (
            <div>
              <p className="bg-slate-50 px-4 py-1.5 text-xs font-semibold text-slate-500">المركبات</p>
              {res.vehicles.map((v) => (
                <button key={v.id} onClick={() => go(`/vehicles/${v.id}`)} className="flex w-full items-center gap-3 px-4 py-2 text-start text-sm hover:bg-slate-50">
                  <Icon name="truck" className="size-4 text-slate-400" />
                  <span className="font-medium ltr">{v.plateNumber}</span>
                  <span className="text-slate-500">{v.make} {v.model}</span>
                </button>
              ))}
            </div>
          )}
          {res.projects.length > 0 && (
            <div>
              <p className="bg-slate-50 px-4 py-1.5 text-xs font-semibold text-slate-500">المشاريع</p>
              {res.projects.map((p) => (
                <button key={p.id} onClick={() => go(`/projects/${p.id}`)} className="flex w-full items-center gap-3 px-4 py-2 text-start text-sm hover:bg-slate-50">
                  <Icon name="folder" className="size-4 text-slate-400" />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-slate-400 ltr">{p.code}</span>
                </button>
              ))}
            </div>
          )}
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

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw] overflow-y-auto shadow-xl">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setDrawer(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="فتح القائمة">
            <Icon name="menu" />
          </button>
          <GlobalSearch />
          <div className="ms-auto flex items-center gap-1">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
