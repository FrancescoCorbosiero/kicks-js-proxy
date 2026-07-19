"use server";

import { z } from "zod";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { countCatalog, countStale } from "@/server/catalog/repo";
import { refreshStaleCatalog } from "@/server/catalog/refresh";
import {
  accumulateIngestionRun,
  createIngestionRun,
  listIngestionRunsBySource,
  type IngestionHistoryEntry,
} from "@/server/ingestion/repo";

/**
 * The Feeds registry backend. Today there is one built-in feed — the KicksDB
 * staleness refresh — but every feed follows the same contract: yield products
 * for a market, ingest through the catalog pipeline, log to ingestion_runs
 * under a "feed:<name>" source. External feeds plug in beside it.
 */

// Not exported: "use server" modules may only export async functions.
const KICKSDB_FEED_SOURCE = "feed:kicksdb";

export interface FeedsState {
  market: string;
  catalogTotal: number;
  staleCount: number;
  ttlSeconds: number;
  lastRuns: IngestionHistoryEntry[];
}

export async function getFeedsState(): Promise<FeedsState> {
  const config = await getActiveConfig();
  const market = config.source.market;
  const ttl = config.source.cacheTtlSeconds;
  const [catalogTotal, staleCount, lastRuns] = await Promise.all([
    countCatalog(market),
    countStale(market, ttl),
    listIngestionRunsBySource(KICKSDB_FEED_SOURCE),
  ]);
  return { market, catalogTotal, staleCount, ttlSeconds: ttl, lastRuns };
}

const RunSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  runId: z.uuid().optional(),
});

export interface FeedRunResult {
  ok: boolean;
  error?: string;
  runId?: string;
  requested?: number;
  refreshed?: number;
  missed?: number;
  remainingStale?: number;
}

/**
 * One round of the built-in KicksDB refresh feed: re-price up to `limit` of the
 * stalest entries. The client loops rounds (passing runId back) until
 * remainingStale is 0 — same accumulate-into-one-history-row pattern as import.
 */
export async function runKicksdbRefresh(
  input: z.infer<typeof RunSchema> = { limit: 100 },
): Promise<FeedRunResult> {
  const parsed = RunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const config = await getActiveConfig();
  const market = config.source.market;
  const ttl = config.source.cacheTtlSeconds;

  let runId = parsed.data.runId;
  try {
    runId = runId ?? (await createIngestionRun(KICKSDB_FEED_SOURCE, market));
  } catch {
    runId = undefined;
  }

  try {
    const source = getSource(config);
    const outcome = await refreshStaleCatalog(source, market, ttl, parsed.data.limit);
    if (runId) {
      // Feed-run semantics on the shared columns: known = refreshed entries,
      // rejected = stale SKUs the batch didn't return this round.
      await accumulateIngestionRun(runId, {
        requested: outcome.requested,
        added: 0,
        known: outcome.refreshed,
        rejected: outcome.missed,
      }).catch(() => {});
    }
    return {
      ok: true,
      runId,
      requested: outcome.requested,
      refreshed: outcome.refreshed,
      missed: outcome.missed,
      remainingStale: await countStale(market, ttl),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (runId) {
      await accumulateIngestionRun(
        runId,
        { requested: 0, added: 0, known: 0, rejected: 0 },
        message,
      ).catch(() => {});
    }
    return { ok: false, error: message, runId };
  }
}
