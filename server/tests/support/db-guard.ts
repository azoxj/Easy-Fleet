/**
 * Safety net for every test that may DROP / TRUNCATE / recreate a schema or database.
 * It runs before the first connection (vitest.config.ts, global-setup, setup) and refuses anything that is not a
 * local, throw-away test database. A name that merely contains "test" is NOT enough: the host must be local (or
 * explicitly allowed) and must not look like AWS/RDS/Render/production.
 */
const DENY_HOST = /(amazonaws|\.rds\.|rds\.|render\.com|onrender|neon\.tech|supabase|azure|cloud\.google|prod)/i;
const DENY_NAME = /(prod|production|render|live|staging)/i;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
export const DESIGNATION_COMMENT = "easy-fleet:allow-init";

type Env = Record<string, string | undefined>;

const parts = (url: string) => {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return null;
  }
};

/** Why this URL must not be used by destructive tests, or null when it is a safe local test database. */
export function testDatabaseProblem(url: string | undefined, env: Env = process.env): string | null {
  if (!url) return "TEST_DATABASE_URL is not set";
  const p = parts(url);
  if (!p) return "TEST_DATABASE_URL cannot be parsed";
  if (env.NODE_ENV === "production") return "NODE_ENV is production";
  if (DENY_HOST.test(p.host)) return `host "${p.host}" looks like a cloud or production database`;
  const allowed = new Set([...LOOPBACK, ...(env.EF_TEST_DB_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);
  if (!allowed.has(p.host)) return `host "${p.host}" is not local (allow a CI host explicitly with EF_TEST_DB_ALLOWED_HOSTS)`;
  if (!/test/i.test(p.database)) return `database "${p.database}" is not named as a test database`;
  if (DENY_NAME.test(p.database)) return `database "${p.database}" looks like a production-like database`;
  const prod = (env.EF_PRODUCTION_DB_NAMES ?? "easyfleet_production").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (prod.includes(p.database.toLowerCase())) return `database "${p.database}" is a designated production database`;
  // The application URL must not point at production either: tests import code that reads it.
  const app = env.DATABASE_URL ? parts(env.DATABASE_URL) : null;
  if (env.DATABASE_URL && (!app || DENY_HOST.test(app.host) || DENY_NAME.test(app.database) || prod.includes(app.database.toLowerCase()))) {
    return "DATABASE_URL in the environment looks like a cloud or production database";
  }
  return null;
}

export function assertSafeTestDatabase(url: string | undefined = process.env.TEST_DATABASE_URL, env: Env = process.env): void {
  const why = testDatabaseProblem(url, env);
  if (why) throw new Error(`Refusing to run destructive database tests: ${why}. Nothing was connected.`);
}

/** Second line of defence once connected: a database carrying the production/initialisation designation is refused. */
export async function assertNotDesignated(query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>): Promise<void> {
  const r = await query(`select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()`);
  const c = String(r.rows[0]?.c ?? "");
  if (c === DESIGNATION_COMMENT || /production/i.test(c)) throw new Error("Refusing to run destructive database tests: the database carries a production designation");
}
