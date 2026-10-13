import { readFileSync } from "node:fs";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import * as schema from "./schema/index.js";

type PoolSettings = {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMs: number;
  idleInTxTimeoutMs: number;
  ssl?: "disable" | "require" | "verify-full";
  sslCaFile?: string;
};

/** Pool options from the settings. Timeouts of 0 mean "off" (pg treats 0/undefined as unlimited). */
export function poolOptions(s: PoolSettings): pg.PoolConfig {
  const ssl: pg.PoolConfig["ssl"] =
    s.ssl === "disable"
      ? false
      : s.ssl === "require"
        ? { rejectUnauthorized: false }
        : s.ssl === "verify-full"
          ? { rejectUnauthorized: true, ...(s.sslCaFile ? { ca: readFileSync(s.sslCaFile, "utf8") } : {}) }
          : undefined; // not set: whatever DATABASE_URL (sslmode=…) says
  return {
    connectionString: s.connectionString,
    max: s.max,
    idleTimeoutMillis: s.idleTimeoutMillis,
    connectionTimeoutMillis: s.connectionTimeoutMillis,
    // Server-side limits so a stuck query or an abandoned transaction can never hold a connection forever.
    ...(s.statementTimeoutMs > 0 ? { statement_timeout: s.statementTimeoutMs } : {}),
    ...(s.idleInTxTimeoutMs > 0 ? { idle_in_transaction_session_timeout: s.idleInTxTimeoutMs } : {}),
    ...(ssl === undefined ? {} : { ssl }),
  };
}

/**
 * An idle client dying (database restart, failover, network cut) makes the pool emit "error". Without a
 * listener Node would treat it as an uncaught exception and kill the process; with one the pool simply
 * drops the client and opens a new connection on the next query.
 */
export function attachPoolErrorHandler(p: pg.Pool, onError: (err: Error) => void = (err) => logger.error("database pool error", { err })) {
  p.on("error", onError);
  return p;
}

export const pool = attachPoolErrorHandler(
  new pg.Pool(
    poolOptions({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      idleInTxTimeoutMs: config.DB_IDLE_IN_TX_TIMEOUT_MS,
      ssl: config.DB_SSL,
      sslCaFile: config.DB_SSL_CA_FILE,
    }),
  ),
);

export const db = drizzle(pool, { schema });

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or a transaction handle. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
