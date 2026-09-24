/**
 * Thin fetch wrapper. The session lives in an HttpOnly cookie the script
 * cannot read; the CSRF token is kept in memory only and sent on writes.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
let onPasswordChangeRequired: (() => void) | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setAuthHandlers(h: { unauthorized?: () => void; passwordChangeRequired?: () => void }) {
  onUnauthorized = h.unauthorized ?? null;
  onPasswordChangeRequired = h.passwordChangeRequired ?? null;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Query; signal?: AbortSignal } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE.has(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  const res = await fetchImpl(`/api${path}${buildQuery(opts.query)}`, {
    method,
    headers,
    credentials: "same-origin",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) {
    const err = json?.error;
    if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized?.();
    if (err?.code === "PASSWORD_CHANGE_REQUIRED") onPasswordChangeRequired?.();
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? "تعذر الاتصال بالخادم", err?.details);
  }
  return json as T;
}

export type Paged<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };
