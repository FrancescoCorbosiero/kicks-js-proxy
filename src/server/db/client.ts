import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * A single shared pool. In dev, Next's hot-reload re-evaluates modules, so we
 * stash the pool on globalThis to avoid exhausting Postgres connections.
 */
const globalForDb = globalThis as unknown as { __pgPool?: Pool };

const pool = globalForDb.__pgPool ?? new Pool({ connectionString: env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForDb.__pgPool = pool;

export const db = drizzle(pool, { schema });
export { schema };
