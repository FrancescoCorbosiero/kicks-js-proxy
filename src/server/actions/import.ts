"use server";

import { z } from "zod";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { growCatalogFromSkus } from "@/server/catalog/service";
import { dbCatalogStore } from "@/server/catalog/store";
import {
  accumulateIngestionRun,
  createIngestionRun,
  listIngestionRuns,
  type IngestionHistoryEntry,
} from "@/server/ingestion/repo";

/**
 * Manual / bulk-file entry into the catalog. Both frontends call the same
 * pipeline the previews use — growCatalogFromSkus — so every imported SKU is
 * GET-verified against KicksDB before it joins the ever-increasing catalog.
 *
 * Large imports are chunked by the client (each SKU costs one verification
 * call): the first chunk opens an ingestion run, later chunks pass `runId`
 * back and accumulate into the same history row.
 */

const ImportSchema = z.object({
  skus: z.array(z.string().min(1)).min(1).max(200),
  market: z.string().min(1).optional(),
  source: z.enum(["manual", "file"]),
  runId: z.uuid().optional(),
});

export interface ImportResult {
  ok: boolean;
  error?: string;
  runId?: string;
  /** This chunk's outcome. */
  requested?: number;
  added?: number;
  known?: number;
  rejected?: string[];
  /** Catalog size after the chunk. */
  total?: number;
}

export async function importSkus(input: z.infer<typeof ImportSchema>): Promise<ImportResult> {
  const parsed = ImportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const config = await getActiveConfig();
  const market = parsed.data.market?.toUpperCase() ?? config.source.market;
  const source = getSource(config);

  let runId = parsed.data.runId;
  try {
    runId = runId ?? (await createIngestionRun(parsed.data.source, market));
  } catch {
    runId = undefined; // history is best-effort; the import itself proceeds
  }

  try {
    const growth = await growCatalogFromSkus(source, dbCatalogStore, parsed.data.skus, market);
    const requested = parsed.data.skus.length;
    const known = Math.max(0, requested - growth.added - growth.rejected.length);
    if (runId) {
      await accumulateIngestionRun(runId, {
        requested,
        added: growth.added,
        known,
        rejected: growth.rejected.length,
      }).catch(() => {});
    }
    return {
      ok: true,
      runId,
      requested,
      added: growth.added,
      known,
      rejected: growth.rejected,
      total: growth.total,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (runId) {
      await accumulateIngestionRun(
        runId,
        { requested: parsed.data.skus.length, added: 0, known: 0, rejected: 0 },
        message,
      ).catch(() => {});
    }
    return { ok: false, error: message, runId };
  }
}

/** Refresh the history panel after an import. */
export async function getIngestionHistory(): Promise<IngestionHistoryEntry[]> {
  return listIngestionRuns();
}
