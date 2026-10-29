import { config } from "../config.js";

/**
 * Structured logger (one JSON line per event in production, readable text in development).
 * Everything is redacted before it is written: passwords, secrets, tokens, cookies, connection strings,
 * and the secret parts of URLs (handover links). Never log request bodies or headers through it.
 */
type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|credential|database_url|private|session|csrf|signature/i;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]*@/gi;
const HANDOVER_PATH = /(\/h\/|\/p\/|\/public\/handover\/|\/portal\/)[A-Za-z0-9_-]{16,}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const RESET_FRAGMENT = /(reset-password#token=)[A-Za-z0-9_-]+/g;

/** Redacts a string that may carry secrets (URLs with credentials, handover tokens, bearer headers). */
export function redactString(v: string): string {
  return v.replace(URL_CREDENTIALS, "$1://***@").replace(HANDOVER_PATH, "$1[redacted]").replace(RESET_FRAGMENT, "$1[redacted]").replace(BEARER, "$1 [redacted]");
}

/** Path of a request URL with secret segments replaced and the query string removed. */
export function safePath(url: string): string {
  return redactString(url.split("?")[0] ?? "");
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 5) return "[truncated]";
  if (value instanceof Error) return serializeError(value, depth);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1)]));
}

export function serializeError(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: redactString(String(err)) };
  const e = err as Error & { code?: string; cause?: unknown };
  return {
    name: e.name,
    message: redactString(e.message),
    ...(e.code ? { code: e.code } : {}),
    ...(e.stack ? { stack: redactString(e.stack).split("\n").slice(0, 8).join("\n") } : {}),
    ...(e.cause && depth < 2 ? { cause: serializeError(e.cause, depth + 1) } : {}),
  };
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (RANK[level] < RANK[config.LOG_LEVEL]) return;
  const safe = fields ? (redact(fields) as Record<string, unknown>) : {};
  const line =
    config.LOG_FORMAT === "json"
      ? JSON.stringify({ ts: new Date().toISOString(), level, msg: redactString(msg), ...safe })
      : `${new Date().toISOString()} ${level.toUpperCase()} ${redactString(msg)}${Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : ""}`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
