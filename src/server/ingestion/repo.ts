import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { ingestionRuns, type IngestionRunRow } from "@/server/db/schema";

/**
 * Catalog-ingestion history: one row per run, whatever the frontend (manual
 * entry, bulk file, a feed). Large imports are chunked client-side, so a run
 * is created by the first chunk and accumulated by the rest — the history
 * shows one line per operator action, not one per chunk.
 */

export async function createIngestionRun(source: string, market: string): Promise<string> {
  const [row] = await db
    .insert(ingestionRuns)
    .values({ source, market })
    .returning({ id: ingestionRuns.id });
  return row.id;
}

export async function accumulateIngestionRun(
  runId: string,
  counts: { requested: number; added: number; known: number; rejected: number },
  error?: string,
): Promise<void> {
  await db
    .update(ingestionRuns)
    .set({
      requested: sql`${ingestionRuns.requested} + ${counts.requested}`,
      added: sql`${ingestionRuns.added} + ${counts.added}`,
      known: sql`${ingestionRuns.known} + ${counts.known}`,
      rejected: sql`${ingestionRuns.rejected} + ${counts.rejected}`,
      ...(error ? { error } : {}),
      finishedAt: new Date(),
    })
    .where(eq(ingestionRuns.id, runId));
}

export interface IngestionHistoryEntry {
  id: string;
  source: string;
  market: string;
  requested: number;
  added: number;
  known: number;
  rejected: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function toEntry(r: IngestionRunRow): IngestionHistoryEntry {
  return {
    id: r.id,
    source: r.source,
    market: r.market,
    requested: r.requested,
    added: r.added,
    known: r.known,
    rejected: r.rejected,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** Recent ingestion runs, newest first. */
export async function listIngestionRuns(limit = 15): Promise<IngestionHistoryEntry[]> {
  try {
    const rows = await db
      .select()
      .from(ingestionRuns)
      .orderBy(desc(ingestionRuns.startedAt))
      .limit(limit);
    return rows.map(toEntry);
  } catch {
    return [];
  }
}

/** Recent runs for one source prefix (e.g. "feed:") — the Feeds tab status. */
export async function listIngestionRunsBySource(
  source: string,
  limit = 5,
): Promise<IngestionHistoryEntry[]> {
  try {
    const rows = await db
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.source, source))
      .orderBy(desc(ingestionRuns.startedAt))
      .limit(limit);
    return rows.map(toEntry);
  } catch {
    return [];
  }
}
