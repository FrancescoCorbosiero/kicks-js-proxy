import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { plans, storeSyncRuns, type StoreSyncRunRow } from "@/server/db/schema";
import { emptySummary } from "@/lib/plan";

/**
 * The cursor row of a stepped store sync — the same shape as the pull's
 * (store_pull_runs): the run lives in the database, every step reads it,
 * plans a slice, and moves it forward.
 */

export async function createSyncRun(market: string, skus: string[]): Promise<StoreSyncRunRow> {
  const [run] = await db
    .insert(storeSyncRuns)
    .values({ market, skus, totals: emptySummary() })
    .returning();
  return run;
}

export async function getSyncRun(runId: string): Promise<StoreSyncRunRow | null> {
  const rows = await db.select().from(storeSyncRuns).where(eq(storeSyncRuns.id, runId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Plans of the run saved AFTER its last committed step belong to a step that
 * never committed (it timed out or crashed between saving and committing).
 * That step is about to be planned again, so they go — otherwise the apply
 * would see those products twice. Both timestamps are the database's clock.
 */
export async function dropUncommittedPlans(run: StoreSyncRunRow): Promise<void> {
  await db.delete(plans).where(and(eq(plans.runId, run.id), gt(plans.createdAt, run.updatedAt)));
}

type StepCounts = Pick<
  StoreSyncRunRow,
  "cursor" | "planned" | "totals" | "notFound" | "notFoundTotal" | "delisted" | "warning" | "catalog"
>;

/**
 * Commit one step: counts and cursor together, and the run marked done when the
 * cursor reaches the end. Guarded on the cursor the step started from, so two
 * advances racing on one run cannot both count the same slice.
 */
export async function commitSyncStep(
  run: StoreSyncRunRow,
  counts: StepCounts,
): Promise<StoreSyncRunRow> {
  const finished = counts.cursor >= run.skus.length;
  const rows = await db
    .update(storeSyncRuns)
    .set({
      ...counts,
      status: finished ? "done" : "running",
      updatedAt: sql`clock_timestamp()`,
      finishedAt: finished ? sql`clock_timestamp()` : null,
    })
    .where(
      and(
        eq(storeSyncRuns.id, run.id),
        eq(storeSyncRuns.status, "running"),
        eq(storeSyncRuns.cursor, run.cursor),
      ),
    )
    .returning();
  if (rows[0]) return rows[0];
  // Lost the race (or the run was cancelled meanwhile): report what is there.
  return (await getSyncRun(run.id))!;
}

export async function failSyncRun(runId: string, error: string): Promise<StoreSyncRunRow> {
  await db
    .update(storeSyncRuns)
    .set({ status: "failed", error, updatedAt: sql`clock_timestamp()`, finishedAt: sql`clock_timestamp()` })
    .where(and(eq(storeSyncRuns.id, runId), eq(storeSyncRuns.status, "running")));
  return (await getSyncRun(runId))!;
}

export async function cancelSyncRun(runId: string): Promise<void> {
  await db
    .update(storeSyncRuns)
    .set({ status: "cancelled", updatedAt: sql`clock_timestamp()`, finishedAt: sql`clock_timestamp()` })
    .where(and(eq(storeSyncRuns.id, runId), eq(storeSyncRuns.status, "running")));
}

/**
 * Whether a run may be applied: any run that is not a stepped sync (a manual
 * preview) is complete by construction; a stepped sync only once it is done.
 * A half-walked store is not a plan for the store.
 */
export async function syncRunApplicable(runId: string): Promise<boolean> {
  const run = await getSyncRun(runId);
  return run == null || run.status === "done";
}
