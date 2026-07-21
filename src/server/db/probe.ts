import "server-only";
import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * Fail fast when the DB is on an older schema than the code. Pages call this
 * inside their guarded load so "you forgot npm run db:migrate" renders the
 * full-page unmigrated notice — instead of best-effort repos silently
 * degrading to empty grids and actions failing with raw messages.
 *
 * Probes one representative object per recent migration wave (cheap: LIMIT 1).
 * Update the probes when a migration adds objects the app can't run without.
 */
export async function assertSchemaCurrent(): Promise<void> {
  // 0005: new table + new catalog_products column.
  await db.execute(sql`select 1 from "store_pull_runs" limit 1`);
  await db.execute(sql`select "image" from "catalog_products" limit 1`);
  // 0006: the external-feed offers table.
  await db.execute(sql`select 1 from "feed_items" limit 1`);
  // 0007: catalog provenance (multi-source catalog).
  await db.execute(sql`select "source" from "catalog_products" limit 1`);
}
