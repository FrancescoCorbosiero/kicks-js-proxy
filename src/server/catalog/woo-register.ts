import "server-only";
import type { SourceProduct } from "@core/core-spine";
import { skuKey } from "@/lib/skus";
import { getActiveConfig } from "@/server/config/repo";
import { getCatalogSources, upsertCatalog } from "@/server/catalog/repo";
import { accumulateIngestionRun, createIngestionRun } from "@/server/ingestion/repo";
import {
  parsePrice,
  variationEuSize,
  variationSizeLabel,
} from "@/server/store-json/match";
import type { StoreModel, StoreProductModel } from "@/server/store-json/model";

/**
 * Register the WooCommerce inventory in the multi-source catalog, source "woo".
 *
 * Runs after every snapshot refresh (REST pull or file upload) so the catalog
 * shows the WHOLE store, not just feed-covered products. Provenance precedence:
 * kicksdb and goldensneakers rows are never touched (they carry real source
 * data); "woo" rows are refreshed; unknown SKUs are added. A woo row is an
 * inventory mirror only — getFreshBySkus/getAnyBySkus exclude it from every
 * price-source read, so sync/apply/rebuild behave exactly as if it weren't
 * in the catalog.
 */

export const WOO_SOURCE = "woo";
export const WOO_INGESTION_SOURCE = "store:woo";

export interface WooRegisterReport {
  products: number; // snapshot products considered
  added: number; // brand-new store-only entries
  refreshed: number; // existing woo rows updated
  skippedOwned: number; // SKUs owned by kicksdb/goldensneakers — left alone
  skippedNoSku: number; // products without a usable SKU (cannot be keyed)
}

/** First product image URL when the snapshot carries one (REST pull keeps it). */
function productImage(p: StoreProductModel): string {
  const images = (p as { images?: unknown }).images;
  if (!Array.isArray(images) || images.length === 0) return "";
  const first = images[0];
  if (first && typeof first === "object") {
    const src = (first as { src?: unknown }).src;
    if (typeof src === "string") return src;
  }
  return "";
}

/**
 * A store product as a SourceProduct so it fits the catalog row shape. The
 * synthesized "offer" carries the CURRENT shelf price (so the grid's price
 * filter/sort and the "from €" line work) — never fed to the plan engine,
 * which cannot see woo rows at all.
 */
function toWooSourceProduct(p: StoreProductModel, market: string): SourceProduct {
  return {
    stockxId: "",
    sku: skuKey(p.sku),
    title: p.name ?? "",
    brand: "",
    image: productImage(p),
    market,
    currency: "EUR",
    source: WOO_SOURCE,
    variants: p.variations.map((v) => {
      const price = parsePrice(v.regular_price);
      return {
        stockxVariantId: `woo:${v.id}`,
        sizeLabel: variationSizeLabel(p.sku, v) ?? "",
        sizeType: "eu",
        upc: v.global_unique_id ?? undefined,
        offers:
          price != null && price > 0
            ? [{ deliveryType: "standard", lowestAsk: price, asks: 0 }]
            : [],
        // keep the normalized size computed once (matching parity, debug aid)
        sizes: (() => {
          const eu = variationEuSize(p.sku, v);
          return eu ? [{ system: "eu", size: eu }] : undefined;
        })(),
      };
    }),
  };
}

/**
 * Best-effort: never throws. Records one ingestion_runs row (source
 * "store:woo") so the dashboard activity feed shows the registration.
 */
export async function registerWooCatalogEntries(model: StoreModel): Promise<WooRegisterReport> {
  const report: WooRegisterReport = {
    products: model.products.length,
    added: 0,
    refreshed: 0,
    skippedOwned: 0,
    skippedNoSku: 0,
  };

  try {
    const config = await getActiveConfig();
    const market = config.source.market;

    // Dedupe by canonical SKU; products without a SKU cannot join a
    // (market, sku)-keyed catalog.
    const bySku = new Map<string, StoreProductModel>();
    for (const p of model.products) {
      if (!p.sku || !p.sku.trim()) {
        report.skippedNoSku += 1;
        continue;
      }
      const key = skuKey(p.sku);
      if (!bySku.has(key)) bySku.set(key, p);
    }

    const sources = await getCatalogSources(market, [...bySku.keys()]);
    const toUpsert: SourceProduct[] = [];
    for (const [key, p] of bySku) {
      const existing = sources.get(key);
      if (existing != null && existing !== WOO_SOURCE) {
        report.skippedOwned += 1; // kicksdb/feed rows carry real source data
        continue;
      }
      if (existing === WOO_SOURCE) report.refreshed += 1;
      else report.added += 1;
      toUpsert.push(toWooSourceProduct(p, market));
    }

    if (toUpsert.length > 0) await upsertCatalog(market, toUpsert);

    try {
      const runId = await createIngestionRun(WOO_INGESTION_SOURCE, market);
      await accumulateIngestionRun(runId, {
        requested: bySku.size + report.skippedNoSku,
        added: report.added,
        known: report.refreshed + report.skippedOwned,
        rejected: report.skippedNoSku,
      });
    } catch {
      /* history is best-effort */
    }
  } catch (e) {
    console.warn(
      "[catalog] woo inventory registration skipped:",
      e instanceof Error ? e.message : String(e),
    );
  }
  return report;
}
