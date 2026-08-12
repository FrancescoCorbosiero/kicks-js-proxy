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
// The schema can only flip fail→pass via a migration (which restarts the app),
// so one success is good forever: don't re-pay 4 roundtrips on every render.
let verified = false;

export async function assertSchemaCurrent(): Promise<void> {
  if (verified) return;
  // 0005: new table + new catalog_products column.
  await db.execute(sql`select 1 from "store_pull_runs" limit 1`);
  await db.execute(sql`select "image" from "catalog_products" limit 1`);
  // 0006: the external-feed offers table.
  await db.execute(sql`select 1 from "feed_items" limit 1`);
  // 0007: catalog provenance (multi-source catalog).
  await db.execute(sql`select "source" from "catalog_products" limit 1`);
  // 0010: catalog navigation metadata. Without these columns the grid's
  // column-scoped reads still succeed while the drawer's full-row read fails —
  // products silently stop opening, with no error anywhere.
  await db.execute(sql`select "category" from "catalog_products" limit 1`);
  // 0011: the orders workspace (orders snapshot + local workflow state).
  await db.execute(sql`select 1 from "order_workflow" limit 1`);
  verified = true;
}
