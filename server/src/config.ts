import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolveMapTiles, type MapTiles } from "./lib/map-tiles.js";

const boolFromEnv = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Warnings about unusable optional settings, printed once at startup (values are never printed). */
const configWarnings: string[] = [];

/** Optional setting parsed with `parse`; an unusable value becomes the fallback plus a warning instead of a startup failure. */
function lenient<T>(parse: (v: string) => T | undefined, warning: string): z.ZodType<T | undefined, string | undefined>;
function lenient<T>(parse: (v: string) => T | undefined, warning: string, fallback: T): z.ZodType<T, string | undefined>;
function lenient<T>(parse: (v: string) => T | undefined, warning: string, fallback?: T) {
  return z
    .string()
    .optional()
    .transform((v): T | undefined => {
      if (v === undefined) return fallback;
      const out = parse(v);
      if (out === undefined) {
        configWarnings.push(`${warning}; ignoring it`);
        return fallback;
      }
      return out;
    });
}

export function parseSmtpSecure(v: string): "TLS" | "STARTTLS" | "NONE" | undefined {
  const s = v.trim().toLowerCase();
  if (["tls", "ssl", "true", "1", "yes", "on", "implicit"].includes(s)) return "TLS";
  if (["starttls", "false", "0", "no", "off"].includes(s)) return "STARTTLS";
  if (["none", "plain"].includes(s)) return "NONE";
  return undefined;
}

/** "Name <address>" or "address" → parts; null when no valid address is found. */
export function parseMailbox(v: string | undefined): { address: string; name: string | null } | null {
  if (!v?.trim()) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<\s*([^<>\s]+)\s*>\s*$/.exec(v);
  const address = (m ? m[2]! : v).trim();
  if (!z.email().safeParse(address).success) return null;
  return { address, name: m && m[1]!.trim() ? m[1]!.trim() : null };
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * Comma-separated browser origins allowed to call the API (CSRF/Origin check).
   * On Render it defaults to the service URL (RENDER_EXTERNAL_URL) when unset.
   */
  APP_ORIGINS: z.string().default(process.env.RENDER_EXTERNAL_URL ?? "http://localhost:5173"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  COOKIE_SECURE: boolFromEnv,
  /**
   * Number of reverse proxies between the client and this process (Caddy/nginx = 1, ALB + Caddy = 2,
   * CloudFront + ALB + Caddy = 3). Unset → 1 in production (the app is never exposed directly there),
   * 0 elsewhere. A wrong value makes every user share the proxy's IP (rate limits, audit IPs).
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),
  WEB_DIST_DIR: z.string().optional(),
  /** log2 of the scrypt cost parameter N. Lowered only in the test environment. */
  SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(17),
  /** Business time zone used to decide what "today" is for expiry rules. */
  APP_TIMEZONE: z.string().default("Asia/Riyadh"),
  /** Private directory for uploaded files. Must NOT be inside the served web root. */
  STORAGE_DIR: z.string().default("./storage"),
  /** Preferred name for the private storage directory (overrides STORAGE_DIR), e.g. a mounted disk path. */
  STORAGE_ROOT: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(10),
  /** Public base URL used in QR codes and handover links (defaults to the first APP_ORIGINS entry). */
  PUBLIC_APP_URL: z.url().optional(),
  /** Public base URL used in emails (password reset links). Takes precedence over PUBLIC_APP_URL. */
  APP_URL: lenient((v) => (z.url().safeParse(v.trim()).success ? v.trim() : undefined), "APP_URL is not a valid URL"),

  // ---- email (server-side only; the browser never talks to the mail provider).
  // Parsed leniently: a mistyped email setting must never stop the whole application from starting —
  // it is reported in the log and in Settings → Email, and email stays "not configured".
  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: lenient((v) => { const n = Number(v.trim()); return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined; }, "SMTP_PORT is not a valid port"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /**
   * TLS = implicit TLS (465), STARTTLS = upgrade (587), NONE = local relay only. Default: TLS on 465, STARTTLS otherwise.
   * Also accepts the usual nodemailer style: true/1/ssl → TLS, false/0 → STARTTLS (upgrade when the server offers it).
   */
  SMTP_SECURE: lenient(parseSmtpSecure, "SMTP_SECURE must be TLS, STARTTLS, NONE, true or false"),
  /** Sender address; "Name <address>" is accepted too (the name is used when EMAIL_FROM_NAME is not set). */
  EMAIL_FROM: z.string().optional(),
  EMAIL_FROM_NAME: z.string().trim().max(100).optional(),
  /** Contact address shown in emails (defaults to the organization email, then EMAIL_FROM). */
  SUPPORT_EMAIL: z.string().optional(),
  /** 32-byte key (base64 or hex) used to encrypt an SMTP password saved from the admin page. */
  EMAIL_SETTINGS_KEY: z.string().optional(),
  /** Optional Bright Washing credentials from the environment (used when not saved in Settings → تكامل API). */
  BRIGHT_WASHING_BASE_URL: z.string().optional(),
  BRIGHT_WASHING_INTEGRATION_ID: z.string().optional(),
  BRIGHT_WASHING_API_SECRET: z.string().optional(),
  /** Minutes a password reset link stays valid. */
  PASSWORD_RESET_TTL_MINUTES: lenient((v) => { const n = Number(v); return Number.isInteger(n) && n >= 5 && n <= 240 ? n : undefined; }, "PASSWORD_RESET_TTL_MINUTES must be 5–240", 30),
  /** Seconds between runs of the email outbox (0 disables the in-process sender). */
  EMAIL_QUEUE_INTERVAL_SECONDS: lenient((v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 3600 ? n : undefined; }, "EMAIL_QUEUE_INTERVAL_SECONDS must be 0–3600", 15),
  /** Days a vehicle handover link stays valid (covers handover + return). */
  HANDOVER_LINK_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /**
   * Map tile URL template ({z}/{x}/{y}, optional {s} and {r}); TILE_URL is accepted as an alias.
   * Unset → CARTO Voyager basemap (no key). A template carrying a key stays server-side:
   * browsers load tiles through /api/map/tiles. See lib/map-tiles.ts.
   */
  MAP_TILE_URL: z.string().optional(),
  TILE_URL: z.string().optional(),
  MAP_TILE_SUBDOMAINS: z.string().optional(),
  MAP_TILE_MAX_ZOOM: z.coerce.number().int().min(1).max(22).optional(),
  /** auto (default): proxy only templates that carry a credential; true/false forces it. */
  MAP_TILE_PROXY: z.enum(["auto", "true", "false"]).default("auto"),
  MAP_ATTRIBUTION: z.string().optional(),
  MAP_DEFAULT_CENTER: z.string().default("24.7136,46.6753"),
  /** Background jobs (expiry scan, cleanup) run in-process unless disabled. */
  DISABLE_JOBS: boolFromEnv,

  // ---- PostgreSQL connection (DATABASE_URL stays the only source of the connection itself)
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** How long a request waits for a free connection before failing (ms). */
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(5000),
  /** Server-side cap on one statement (ms, 0 = unlimited). One-off scripts (migrate, seed) lift it. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  /** Aborts sessions that sit idle inside an open transaction (ms, 0 = off). */
  DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(30_000),
  /** disable | require (encrypted, certificate not verified) | verify-full (RDS: with DB_SSL_CA_FILE). Unset → whatever DATABASE_URL says. */
  DB_SSL: z.enum(["disable", "require", "verify-full"]).optional(),
  /** PEM bundle of the CA that signed the database certificate (e.g. the AWS RDS global bundle). */
  DB_SSL_CA_FILE: z.string().optional(),

  // ---- File storage
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z.string().trim().optional(),
  S3_REGION: z.string().trim().optional(),
  /** Optional key prefix inside the bucket (e.g. "prod/"). */
  S3_PREFIX: z.string().trim().optional(),
  /** Only for S3-compatible stores (MinIO, LocalStack). Leave unset on AWS. */
  S3_ENDPOINT: z.string().trim().optional(),
  S3_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  S3_KMS_KEY_ID: z.string().trim().optional(),
  /** /api/readyz reports storage as not ready when the local storage volume has less free space than this (MB). */
  STORAGE_MIN_FREE_MB: z.coerce.number().int().min(0).max(1_000_000).default(512),
  /** /api/readyz also fails when the volume holding temporary files and logs (DISK_CHECK_PATH, default the OS temp dir) has less free space than this (MB, 0 = off). Matters on AWS where files live in S3. */
  DISK_MIN_FREE_MB: z.coerce.number().int().min(0).max(1_000_000).default(256),
  DISK_CHECK_PATH: z.string().optional(),
  /** Opt-in: delete uploaded files (object + row) that no record references after ORPHAN_FILE_DAYS. */
  ORPHAN_FILE_CLEANUP: boolFromEnv,
  ORPHAN_FILE_DAYS: z.coerce.number().int().min(1).max(365).default(7),

  // ---- Logging / lifecycle
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** json (default in production, one line per event) or text. */
  LOG_FORMAT: z.enum(["json", "text"]).optional(),
  /** One structured line per request (path tokens redacted). Unset → on in production. */
  LOG_REQUESTS: z.enum(["true", "false", "1", "0"]).optional(),
  /** Grace period for in-flight requests on SIGTERM before the process exits (seconds). */
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
});

/**
 * Secrets may come from files instead of environment variables (systemd LoadCredential, a boot script that
 * wrote AWS Secrets Manager values to /run, Docker/K8s secrets): NAME_FILE=/path reads the file into NAME
 * when NAME itself is not set. File contents are never logged.
 */
export const FILE_SECRET_KEYS = [
  "DATABASE_URL",
  "EMAIL_SETTINGS_KEY",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "BRIGHT_WASHING_INTEGRATION_ID",
  "BRIGHT_WASHING_API_SECRET",
  "BOOTSTRAP_ADMIN_PASSWORD",
] as const;

export function applyFileSecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of FILE_SECRET_KEYS) {
    const file = out[`${key}_FILE`]?.trim();
    if (!file || out[key]?.trim()) continue;
    try {
      out[key] = readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw new Error(`${key}_FILE is set but the file cannot be read`);
    }
  }
  return out;
}

export type AppConfig = Omit<z.infer<typeof EnvSchema>, "TRUST_PROXY" | "LOG_FORMAT" | "LOG_REQUESTS"> & {
  TRUST_PROXY: number;
  LOG_FORMAT: "json" | "text";
  LOG_REQUESTS: boolean;
  appOrigins: string[];
  publicAppUrl: string;
  mapTiles: MapTiles;
};

function loadConfig(): AppConfig {
  // Empty values (e.g. a blank variable in a hosting dashboard) count as "not set".
  const env = Object.fromEntries(Object.entries(applyFileSecrets(process.env)).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") {
    if (!cfg.COOKIE_SECURE) throw new Error("COOKIE_SECURE must be true in production");
    if (cfg.SCRYPT_LOG_N < 17) throw new Error("SCRYPT_LOG_N must be >= 17 in production");
  }
  if (cfg.STORAGE_PROVIDER === "s3") {
    if (!cfg.S3_BUCKET) throw new Error("S3_BUCKET is required when STORAGE_PROVIDER=s3");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.S3_BUCKET)) throw new Error("S3_BUCKET is not a valid bucket name");
    if (!cfg.S3_REGION && !process.env.AWS_REGION && !cfg.S3_ENDPOINT) throw new Error("S3_REGION (or AWS_REGION) is required when STORAGE_PROVIDER=s3");
    if (cfg.S3_SSE === "aws:kms" && cfg.S3_KMS_KEY_ID === "") throw new Error("S3_KMS_KEY_ID must not be empty");
  }
  if (cfg.DB_SSL === "verify-full" && !cfg.DB_SSL_CA_FILE) configWarnings.push("DB_SSL=verify-full without DB_SSL_CA_FILE verifies against the system CA store only");
  const production = cfg.NODE_ENV === "production";
  if (production && cfg.TRUST_PROXY === 0) configWarnings.push("TRUST_PROXY=0 in production: behind a reverse proxy every user would share the proxy's IP (rate limits, audit IPs)");
  const appOrigins = cfg.APP_ORIGINS.split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (cfg.NODE_ENV === "production") {
    // Cookies are Secure/__Host-: the browser origin must be HTTPS and never localhost.
    const bad = appOrigins.filter((o) => !/^https:\/\//.test(o) || /\/\/(localhost|127\.)/.test(o));
    if (!appOrigins.length || bad.length) throw new Error(`APP_ORIGINS must list the public https origin(s) in production (got: ${cfg.APP_ORIGINS})`);
  }
  const mapTiles = resolveMapTiles({
    url: cfg.MAP_TILE_URL ?? cfg.TILE_URL,
    subdomains: cfg.MAP_TILE_SUBDOMAINS,
    attribution: cfg.MAP_ATTRIBUTION,
    maxZoom: cfg.MAP_TILE_MAX_ZOOM,
    proxy: cfg.MAP_TILE_PROXY,
    production: cfg.NODE_ENV === "production",
  });
  if (mapTiles.warning) console.warn(`[easy-fleet] ${mapTiles.warning}`);
  if (cfg.EMAIL_SETTINGS_KEY && !emailKeyBytes(cfg.EMAIL_SETTINGS_KEY)) {
    configWarnings.push("EMAIL_SETTINGS_KEY must be 32 bytes, base64 or hex encoded; ignoring it (SMTP passwords cannot be saved from the admin page)");
    cfg.EMAIL_SETTINGS_KEY = undefined;
  }
  const from = parseMailbox(cfg.EMAIL_FROM);
  if (cfg.EMAIL_FROM && !from) configWarnings.push("EMAIL_FROM is not a valid email address; ignoring it (email will be reported as not configured)");
  cfg.EMAIL_FROM = from?.address;
  if (!cfg.EMAIL_FROM_NAME && from?.name) cfg.EMAIL_FROM_NAME = from.name;
  const support = parseMailbox(cfg.SUPPORT_EMAIL);
  if (cfg.SUPPORT_EMAIL && !support) configWarnings.push("SUPPORT_EMAIL is not a valid email address; ignoring it");
  cfg.SUPPORT_EMAIL = support?.address;
  for (const w of configWarnings) console.warn(`[easy-fleet] ${w}`);
  const publicAppUrl = (cfg.APP_URL ?? cfg.PUBLIC_APP_URL ?? appOrigins[0] ?? "http://localhost:4000").replace(/\/$/, "");
  // Warn rather than refuse to start: an existing deployment must keep running.
  if (cfg.NODE_ENV === "production" && !/^https:\/\//.test(publicAppUrl)) console.warn("[easy-fleet] APP_URL should be the public https URL in production (it is used in password reset links)");
  return {
    ...cfg,
    TRUST_PROXY: cfg.TRUST_PROXY ?? (production ? 1 : 0),
    LOG_FORMAT: cfg.LOG_FORMAT ?? (production ? "json" : "text"),
    LOG_REQUESTS: cfg.LOG_REQUESTS ? cfg.LOG_REQUESTS === "true" || cfg.LOG_REQUESTS === "1" : production,
    STORAGE_DIR: cfg.STORAGE_ROOT ?? cfg.STORAGE_DIR,
    appOrigins,
    publicAppUrl,
    mapTiles,
  };
}

/** The EMAIL_SETTINGS_KEY as 32 raw bytes (base64 or hex), or null when malformed. */
export function emailKeyBytes(v: string): Buffer | null {
  const t = v.trim();
  const b = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  return b.length === 32 ? b : null;
}

export const config = loadConfig();
