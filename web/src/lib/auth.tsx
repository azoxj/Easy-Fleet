import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setAuthHandlers, setCsrfToken } from "./api";
import { can as canFn } from "./permissions";
import type { Me, Scope } from "./types";

type AuthState = {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refresh: () => Promise<Me | null>;
  can: (perm: string, min?: Scope) => boolean;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ data: Me }>("/auth/me");
      setCsrfToken(res.data.csrfToken);
      setMe(res.data);
      return res.data;
    } catch {
      setCsrfToken(null);
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setAuthHandlers({
      unauthorized: () => {
        setCsrfToken(null);
        setMe(null);
      },
      passwordChangeRequired: () => setMe((m) => (m ? { ...m, mustChangePassword: true } : m)),
    });
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ data: { csrfToken: string } }>("/auth/login", { method: "POST", body: { email, password } });
      setCsrfToken(res.data.csrfToken);
      const m = await refresh();
      if (!m) throw new Error("تعذر تحميل بيانات المستخدم");
      return m;
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken(null);
      setMe(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ me, loading, login, logout, refresh, can: (perm, min) => canFn(me, perm, min) }),
    [me, loading, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
