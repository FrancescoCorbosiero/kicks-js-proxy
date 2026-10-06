import "server-only";
import { and, lt, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyAudit, ingestionRuns, plans, storeSyncRuns } from "@/server/db/schema";

/**
 * The run logs, cut back once a day (the scheduler's daily run).
 *
 * Since the store follows the feed every quarter of an hour, these tables gain
 * a row per cycle whether or not anything changed: the GS sync's ingestion run,
 * an apply_audit row whenever something was written, and — for a sync started
 * from the Sync tab — the stepped run with the SKU list it walked. Every screen
 * reads only their latest rows. Nothing here is state: the snapshot, the
 * catalog, the ledger, locks and plans are never touched.
 */

/** Stepped syncs: a run nobody applied in a week never will be. */
const SYNC_RUN_DAYS = 7;
/** Ingestion runs and the Sync tab's history. */
const LOG_DAYS = 90;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

export async function pruneRunLogs(): Promise<{ syncRuns: number; ingestionRuns: number; applyRuns: number }> {
  // Only runs whose plans are gone: a run without its row reads as a manual
  // preview, "complete by construction" (syncRunApplicable) — a half-walked
  // run must never get there with plans left to apply.
  const syncRuns = await db
    .delete(storeSyncRuns)
    .where(
      and(
        lt(storeSyncRuns.startedAt, daysAgo(SYNC_RUN_DAYS)),
        sql`not exists (select 1 from ${plans} p where p.run_id = ${storeSyncRuns.id})`,
      ),
    )
    .returning({ id: storeSyncRuns.id });
  const ingestion = await db
    .delete(ingestionRuns)
    .where(lt(ingestionRuns.startedAt, daysAgo(LOG_DAYS)))
    .returning({ id: ingestionRuns.id });
  const apply = await db
    .delete(applyAudit)
    .where(lt(applyAudit.startedAt, daysAgo(LOG_DAYS)))
    .returning({ id: applyAudit.id });
  return { syncRuns: syncRuns.length, ingestionRuns: ingestion.length, applyRuns: apply.length };
}
