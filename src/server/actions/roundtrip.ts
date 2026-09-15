import "server-only";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { getActiveSnapshot, saveSnapshot } from "@/server/store-json/repo";
import { parseStoreModel } from "@/server/store-json/model";
import type { StoreModel } from "@/server/store-json/model";
import { partitionSearchable } from "@/server/store-json/searchable";
import { applyRoundtripSync } from "@/server/store-json/sync";
import type { SyncMode, SyncSummary } from "@/server/store-json/sync";
import { skuKey } from "@/lib/skus";
import { db } from "@/server/db/client";
import { applyAudit } from "@/server/db/schema";

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface SearchableStats {
  products: number; // products in the file
  searchable: number; // SKUs that resolve on KicksDB
  stripped: number; // SKUs not on KicksDB (left untouched)
  strippedSkus: string[];
}

export interface ExportReport {
  ok: boolean;
  error?: string;
  scope: "all" | "searchable";
  stats?: SearchableStats;
  model?: StoreModel;
}

export interface SyncReport {
  ok: boolean;
  error?: string;
  mode: SyncMode;
  dryRun: boolean;
  stats?: SearchableStats;
  summary?: SyncSummary;
  /** The lean re-import file: only changed products. Always set for apply. */
  output?: StoreModel;
}

function errMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

function modelSkus(model: StoreModel): string[] {
  return model.products.map((p) => p.sku).filter((s): s is string => !!s);
}

/* -------------------------------------------------------------------------- */
/* 1. EXPORT — emit the active round-trip snapshot                            */
/* -------------------------------------------------------------------------- */

/**
 * Return the active store round-trip model. With `scope: "searchable"` the SKU
 * list is stripped to only the products KicksDB can actually price — the core
 * optimization, since ~half a shop's catalog never resolves on StockX.
 */
export async function roundtripExport(scope: "all" | "searchable" = "all"): Promise<ExportReport> {
  const snapshot = await getActiveSnapshot();
  if (!snapshot) {
    return { ok: false, scope, error: "No store snapshot — upload your store JSON first." };
  }

  if (scope === "all") {
    return {
      ok: true,
      scope,
      model: snapshot,
      stats: {
        products: snapshot.products.length,
        searchable: snapshot.products.length,
        stripped: 0,
        strippedSkus: [],
      },
    };
  }

  try {
    const config = await getActiveConfig();
    const market = config.source.market;
    const source = getSource(config);
    const priced = await source.getPricesBatch(modelSkus(snapshot), market);
    const known = new Set(priced.map((p) => skuKey(p.sku)));
    const { searchable, strippedSkus } = partitionSearchable(snapshot, known);
    return {
      ok: true,
      scope,
      model: searchable,
      stats: {
        products: snapshot.products.length,
        searchable: searchable.products.length,
        stripped: strippedSkus.length,
        strippedSkus,
      },
    };
  } catch (e) {
    return { ok: false, scope, error: errMessage(e) };
  }
}

/* -------------------------------------------------------------------------- */
/* 2/3. PREVIEW (dry-run) and APPLY (commit) — reprice + reconcile            */
/* -------------------------------------------------------------------------- */

interface RunOptions {
  persist: boolean; // true => apply: save the merged model as the new snapshot
  includeOutput: boolean; // include the changed-products re-import file in the response
}

async function runSync(body: string, mode: SyncMode, opts: RunOptions): Promise<SyncReport> {
  let model: StoreModel;
  try {
    model = parseStoreModel(body);
  } catch (e) {
    return { ok: false, mode, dryRun: !opts.persist, error: errMessage(e) };
  }

  try {
    const config = await getActiveConfig();
    const market = config.source.market;
    const source = getSource(config);

    const skus = modelSkus(model);
    // Bulk price the file's SKUs; KicksDB only returns the searchable ones, so the
    // returned set IS the searchable strip and the rest are reported untouched.
    const priced = await source.getPricesBatch(skus, market);
    const nameBySku = new Map(model.products.map((p) => [skuKey(p.sku), p.name ?? ""]));
    for (const p of priced) {
      const name = nameBySku.get(skuKey(p.sku));
      if (name) p.title = name;
    }
    const returned = new Set(priced.map((p) => skuKey(p.sku)));
    const strippedSkus = skus.filter((s) => !returned.has(skuKey(s)));

    const outcome = applyRoundtripSync(model, priced, config, { mode });
    if (opts.persist) await saveSnapshot(outcome.full);

    const summary: SyncSummary = {
      productsChanged: outcome.productsChanged,
      productsCreated: outcome.productsCreated,
      variationsUpdated: outcome.variationsUpdated,
      variationsCreated: outcome.variationsCreated,
      variationsRemoved: outcome.variationsRemoved,
      gtinsWritten: outcome.gtinsWritten,
      skipped: outcome.skipped,
    };

    await writeAudit(mode, !opts.persist, summary, strippedSkus.length);

    return {
      ok: true,
      mode,
      dryRun: !opts.persist,
      stats: {
        products: model.products.length,
        searchable: priced.length,
        stripped: strippedSkus.length,
        strippedSkus,
      },
      summary,
      output: opts.includeOutput ? outcome.changed : undefined,
    };
  } catch (e) {
    return { ok: false, mode, dryRun: !opts.persist, error: errMessage(e) };
  }
}

/** Dry-run: report what would change. Persists nothing. */
export function roundtripPreview(body: string, mode: SyncMode, includeOutput = false): Promise<SyncReport> {
  return runSync(body, mode, { persist: false, includeOutput });
}

/** Commit: merge changes into the active snapshot and return the re-import file. */
export function roundtripApply(body: string, mode: SyncMode): Promise<SyncReport> {
  return runSync(body, mode, { persist: true, includeOutput: true });
}

/** Best-effort audit row; never fails the request if the table is missing. */
async function writeAudit(
  mode: SyncMode,
  dryRun: boolean,
  summary: SyncSummary,
  stripped: number,
): Promise<void> {
  try {
    await db.insert(applyAudit).values({
      status: dryRun ? "dry_run" : "applied",
      dryRun,
      updatedCount:
        summary.variationsUpdated + summary.variationsCreated + summary.variationsRemoved,
      result: { source: "roundtrip", mode, stripped, ...summary },
    });
  } catch (e) {
    console.warn("[roundtrip] audit skipped:", errMessage(e));
  }
}
