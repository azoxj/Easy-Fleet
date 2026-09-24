import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_ORIGINS: z.string().default("http://localhost:5173"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  COOKIE_SECURE: boolFromEnv,
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  WEB_DIST_DIR: z.string().optional(),
  /** log2 of the scrypt cost parameter N. Lowered only in the test environment. */
  SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(17),
  /** Business time zone used to decide what "today" is for expiry rules. */
  APP_TIMEZONE: z.string().default("Asia/Riyadh"),
  /** Private directory for uploaded files. Must NOT be inside the served web root. */
  STORAGE_DIR: z.string().default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(10),
  /** Public base URL used in QR codes and handover links (defaults to the first APP_ORIGINS entry). */
  PUBLIC_APP_URL: z.url().optional(),
  /** Days a vehicle handover link stays valid (covers handover + return). */
  HANDOVER_LINK_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /**
   * Optional map tile URL template with {z}/{x}/{y}. When it contains an API key
   * it stays server-side: browsers load tiles through /api/map/tiles.
   * Unset → public OpenStreetMap tiles (no key).
   */
  MAP_TILE_URL: z.string().optional(),
  MAP_ATTRIBUTION: z.string().default("© OpenStreetMap contributors"),
  MAP_DEFAULT_CENTER: z.string().default("24.7136,46.6753"),
  /** Background jobs (expiry scan, cleanup) run in-process unless disabled. */
  DISABLE_JOBS: boolFromEnv,
});

export type AppConfig = z.infer<typeof EnvSchema> & { appOrigins: string[]; publicAppUrl: string };

function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") {
    if (!cfg.COOKIE_SECURE) throw new Error("COOKIE_SECURE must be true in production");
    if (cfg.SCRYPT_LOG_N < 17) throw new Error("SCRYPT_LOG_N must be >= 17 in production");
  }
  const appOrigins = cfg.APP_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return { ...cfg, appOrigins, publicAppUrl: (cfg.PUBLIC_APP_URL ?? appOrigins[0] ?? "http://localhost:4000").replace(/\/$/, "") };
}

export const config = loadConfig();
