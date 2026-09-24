import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, buildQuery, setAuthHandlers, setCsrfToken } from "./api";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

describe("api client", () => {
  beforeEach(() => {
    setCsrfToken(null);
    setAuthHandlers({});
  });

  it("builds query strings and skips empty values", () => {
    expect(buildQuery({ q: "abc", page: 2, status: "", x: undefined, y: null })).toBe("?q=abc&page=2");
    expect(buildQuery({})).toBe("");
  });

  it("sends the CSRF token only on state-changing requests", async () => {
    setCsrfToken("tok");
    const f = mockFetch(200, { data: 1 });
    await api("/x", {}, f);
    await api("/x", { method: "POST", body: { a: 1 } }, f);
    const [, getInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [, postInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect((getInit.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect((postInit.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
    expect(postInit.credentials).toBe("same-origin");
    expect(postInit.body).toBe('{"a":1}');
  });

  it("maps server errors to ApiError and triggers the 401 handler", async () => {
    const unauthorized = vi.fn();
    setAuthHandlers({ unauthorized });
    await expect(api("/vehicles", {}, mockFetch(401, { error: { code: "UNAUTHORIZED", message: "يجب تسجيل الدخول" } }))).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "يجب تسجيل الدخول",
    });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("does not treat a failed login as a session expiry", async () => {
    const unauthorized = vi.fn();
    setAuthHandlers({ unauthorized });
    await expect(api("/auth/login", { method: "POST", body: {} }, mockFetch(401, { error: { code: "UNAUTHORIZED", message: "x" } }))).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("signals forced password change", async () => {
    const passwordChangeRequired = vi.fn();
    setAuthHandlers({ passwordChangeRequired });
    await expect(api("/vehicles", {}, mockFetch(403, { error: { code: "PASSWORD_CHANGE_REQUIRED", message: "x" } }))).rejects.toThrow();
    expect(passwordChangeRequired).toHaveBeenCalledOnce();
  });

  it("returns undefined for 204", async () => {
    expect(await api("/x", { method: "POST" }, mockFetch(204, null))).toBeUndefined();
  });
});
