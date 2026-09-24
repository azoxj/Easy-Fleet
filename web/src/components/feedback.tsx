import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button, Modal, cx } from "./ui";

// ------------------------------------------------------------------ Toasts
type Toast = { id: number; tone: "success" | "error" | "info"; message: string };
type ToastApi = { success: (m: string) => void; error: (m: string) => void; info: (m: string) => void };
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const api = useRef<ToastApi>({ success: (m) => push("success", m), error: (m) => push("error", m), info: (m) => push("info", m) });
  return (
    <ToastContext.Provider value={api.current}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:start-4 sm:items-start" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cx(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-lg ring-1",
              t.tone === "success" && "bg-emerald-50 text-emerald-900 ring-emerald-200",
              t.tone === "error" && "bg-red-50 text-red-900 ring-red-200",
              t.tone === "info" && "bg-white text-slate-800 ring-slate-200",
            )}
          >
            <Icon name={t.tone === "success" ? "check" : t.tone === "error" ? "alert" : "bell"} className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

// ------------------------------------------------------------------ Confirm dialog
type ConfirmOptions = { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean };
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title ?? ""}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>إلغاء</Button>
            <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)}>{state?.confirmLabel ?? "تأكيد"}</Button>
          </>
        }
      >
        <div className="text-sm leading-7 text-slate-600">{state?.message}</div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx;
}
