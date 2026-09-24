import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema/index.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or a transaction handle. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
