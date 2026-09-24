import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Rebuilds the test database from the real migrations, then syncs the catalog. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(drizzle(pool), { migrationsFolder: path.resolve("drizzle") });
  await pool.end();

  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = "test";
  process.env.SCRYPT_LOG_N = "12";
  const { db, pool: appPool } = await import("../src/db/client.js");
  const { syncCatalog } = await import("../src/db/bootstrap.js");
  await db.transaction((tx) => syncCatalog(tx));
  await appPool.end();
}
