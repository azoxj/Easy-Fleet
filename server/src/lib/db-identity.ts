/**
 * Who a DATABASE_URL points at — host, port and database name only. The user name, the password and the query
 * string are never returned, so the result is always safe to print.
 */
export type DbIdentity = { host: string; port: string; database: string };

export function databaseIdentity(url: string): DbIdentity {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port || "5432", database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return { host: "(unparseable)", port: "", database: "(unparseable)" };
  }
}

/** Databases that must never receive demo data, whatever flags are set (comma-separated, default easyfleet_production). */
export function productionDatabaseNames(env: Record<string, string | undefined> = process.env): string[] {
  return (env.EF_PRODUCTION_DB_NAMES ?? "easyfleet_production")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Why the demo seed must refuse on this database, or null when it may run (the NODE_ENV rules are separate). */
export function demoSeedBlockReason(url: string, env: Record<string, string | undefined> = process.env): string | null {
  const id = databaseIdentity(url);
  if (env.EF_FORBID_DEMO_SEED === "true") return "EF_FORBID_DEMO_SEED=true";
  if (productionDatabaseNames(env).includes(id.database.toLowerCase())) return `database "${id.database}" is a designated production database`;
  return null;
}
