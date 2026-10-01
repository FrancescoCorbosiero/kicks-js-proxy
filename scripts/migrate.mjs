#!/usr/bin/env node
/**
 * Apply the pending database migrations (drizzle/), then exit — the same
 * migrations `npm run db:migrate` applies, run through drizzle-orm's migrator
 * instead of drizzle-kit, so it works in the production image, which ships
 * runtime dependencies only. Both record what they applied in the same table,
 * so either can take over from the other.
 *
 * The Docker image runs it before every start: applied migrations are
 * skipped, so a restart is a no-op. It waits for the database first — after
 * a reboot Docker restarts every container at once, Postgres included.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Through CommonJS: the image ships pg as the server bundle loads it.
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { drizzle } = require("drizzle-orm/node-postgres");
const { migrate } = require("drizzle-orm/node-postgres/migrator");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
try {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      console.log(`migrate: waiting for the database (${error.code ?? error.message})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  console.log("migrate: database is up to date");
} catch (error) {
  console.error("migrate: failed —", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
