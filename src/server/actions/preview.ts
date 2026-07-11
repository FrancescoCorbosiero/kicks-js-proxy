"use server";

import { z } from "zod";
import { buildPlan } from "@core/core-spine";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { resolveFromModel, sourceEuSize } from "@/server/store-json/match";
import { savePlan } from "@/server/plans/repo";
import { getCache } from "@/server/cache/redis";
import { fetchProductsCached } from "@/server/kicks/service";
import { resolveSkusViaCatalog, growCatalogFromSkus } from "@/server/catalog/service";
import { dbCatalogStore } from "@/server/catalog/store";
import { getOverrides } from "@/server/overrides/repo";
import { followSaleRuleFor, manualPriceFor, type StoreOverrides } from "@/server/overrides/model";
import { isExactMatch } from "@/lib/match";
import { skuKey } from "@/lib/skus";
import type { PreviewPlan } from "@/lib/plan";

const InputSchema = z
  .object({
    mode: z.enum(["skus", "query"]),
    // newline/comma separated in the form; normalized to string[] before validation
    skus: z.array(z.string().min(1)).max(500).optional(),
    query: z.string().min(1).optional(),
    market: z.string().min(1).optional(),
  })
  .refine((v) => (v.mode === "skus" ? !!v.skus?.length : !!v.query), {
    message: "Provide SKUs in 'skus' mode, or a query in 'query' mode.",
  });

export type PreviewInput = z.infer<typeof InputSchema>;

export interface CatalogStats {
  total: number; // total unique SKUs known in the catalog (this market)
  added: number; // brand-new GET-verified SKUs added on this run
  rejected: number; // new SKUs that weren't fetchable on KicksDB (no GET 200)
}

export interface FetchStats {
  products: number;
  fromCache: number;
  fetched: number;
  notFound: string[];
  catalog?: CatalogStats;
}

export interface PreviewResult {
  ok: boolean;
  error?: string;
  plans: PreviewPlan[];
  stats?: FetchStats;
}

/**
 * Build + persist a PreviewPlan per fetched product: match against the store
 * snapshot, run buildPlan, attach EU sizes and the exact-match flag.
 */
async function assemblePlans(
  products: import("@core/core-spine").SourceProduct[],
  config: import("@core/config").AppConfig,
  snapshot: Awaited<ReturnType<typeof getActiveSnapshot>>,
  market: string,
  term: string | null,
  overrides: StoreOverrides,
): Promise<PreviewPlan[]> {
  const out: PreviewPlan[] = [];
  for (const product of products) {
    const mappings = snapshot ? resolveFromModel(snapshot, product) : new Map();

    // EU size per variant — needed both for the table and to key manual-price
    // overrides (which are stored by parent SKU + EU size).
    const euSizes: Record<string, string> = {};
    for (const v of product.variants) {
      const eu = sourceEuSize(v); // normalized number, e.g. "42.5"
      if (eu) euSizes[v.stockxVariantId] = eu;
    }

    // Overlay operator overrides: lock manual prices onto the matched mappings.
    const manualPrices: Record<string, number> = {};
    for (const v of product.variants) {
      const eu = euSizes[v.stockxVariantId];
      const m = mappings.get(v.stockxVariantId);
      if (!eu || !m) continue;
      const manual = manualPriceFor(overrides, product.sku, eu);
      if (manual != null) {
        m.manualPrice = manual;
        manualPrices[v.stockxVariantId] = manual;
      }
    }

    const followSaleRule = followSaleRuleFor(overrides, product.sku);
    const plan = buildPlan(product, config, mappings, { followSaleRule });
    const { id, summary } = await savePlan(plan, market);

    out.push({
      planId: id,
      market,
      sku: product.sku,
      title: product.title,
      brand: product.brand,
      plan,
      summary,
      euSizes,
      exactMatch: term ? isExactMatch(term, product.sku, product.title) : false,
      followSaleRule,
      manualPrices,
    });
  }
  return out;
}

function errMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

/**
 * Manual preview: fetch from KicksDB by SKU list or query, match against the
 * store snapshot, run buildPlan() per product, persist, return for the table.
 */
export async function fetchAndPreview(input: PreviewInput): Promise<PreviewResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; "), plans: [] };
  }

  const config = await getActiveConfig();
  const market = parsed.data.market ?? config.source.market;
  const source = getSource(config);
  const snapshot = await getActiveSnapshot();
  const overrides = await getOverrides();
  const cache = getCache();
  const ttl = config.source.cacheTtlSeconds;

  try {
    // SKU mode resolves through the persistent catalog (smart cache, upsert on
    // fresh fetch). Query mode uses the Redis whole-result cache.
    const result =
      parsed.data.mode === "skus"
        ? await resolveSkusViaCatalog(source, dbCatalogStore, parsed.data.skus!, market, ttl)
        : { ...(await fetchProductsCached(source, cache, parsed.data.query!, market, ttl)), notFound: [] as string[] };

    const term = parsed.data.mode === "query" ? parsed.data.query! : null;
    const plans = await assemblePlans(result.products, config, snapshot, market, term, overrides);

    // In SKU mode the catalog resolver already GET-verifies + upserts every hit,
    // so report the live catalog size and what this run added/rejected.
    let catalog: CatalogStats | undefined;
    if (parsed.data.mode === "skus") {
      try {
        catalog = {
          total: await dbCatalogStore.count(market),
          added: result.fetched,
          rejected: result.notFound.length,
        };
      } catch (e) {
        console.warn("[catalog] count skipped:", errMessage(e));
      }
    }

    return {
      ok: true,
      plans,
      stats: {
        products: result.products.length,
        fromCache: result.fromCache,
        fetched: result.fetched,
        notFound: result.notFound,
        catalog,
      },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), plans: [] };
  }
}

/**
 * File-driven preview: fetch StockX prices for a set of SKUs and preview them
 * against the uploaded store snapshot. With no `skusOverride` it previews the
 * whole file (the primary workflow). With one — e.g. a selection from the KicksDB
 * catalog — it previews just those SKUs, still matched to the snapshot so the
 * export stays a valid Woo re-import. Either way the bulk price path is used, so
 * it scales to thousands of SKUs.
 */
export async function previewFromStore(
  marketOverride?: string,
  skusOverride?: string[],
): Promise<PreviewResult> {
  const config = await getActiveConfig();
  const snapshot = await getActiveSnapshot();
  if (!snapshot) {
    return { ok: false, error: "Upload a store snapshot first.", plans: [] };
  }
  const skus =
    skusOverride && skusOverride.length > 0
      ? skusOverride
      : snapshot.products.map((p) => p.sku).filter((s): s is string => !!s);
  if (skus.length === 0) {
    return { ok: false, error: "The store snapshot has no products.", plans: [] };
  }

  const market = marketOverride ?? config.source.market;
  const source = getSource(config);
  const overrides = await getOverrides();

  try {
    // Bulk endpoint (show_sizes) returns EU sizes + prices in one call, chunked at
    // 50 SKUs -> a 1000-SKU file is ~20 calls, cold or warm. Product names come
    // from the snapshot (the bulk response carries no title/brand).
    const products = await source.getPricesBatch(skus, market);
    const nameBySku = new Map(snapshot.products.map((p) => [skuKey(p.sku), p.name ?? ""]));
    for (const p of products) {
      const name = nameBySku.get(skuKey(p.sku));
      if (name) p.title = name;
    }

    const returned = new Set(products.map((p) => skuKey(p.sku)));
    const notFound = skus.filter((s) => !returned.has(skuKey(s)));

    // Grow the ever-increasing catalog: GET-verify the brand-new SKUs the bulk
    // call returned and add only those fetchable on KicksDB. Best-effort — a
    // catalog failure must never break the preview.
    let catalog: CatalogStats | undefined;
    try {
      const growth = await growCatalogFromSkus(
        source,
        dbCatalogStore,
        products.map((p) => p.sku),
        market,
      );
      catalog = { total: growth.total, added: growth.added, rejected: growth.rejected.length };
    } catch (e) {
      console.warn("[catalog] growth skipped:", errMessage(e));
    }

    const plans = await assemblePlans(products, config, snapshot, market, null, overrides);
    return {
      ok: true,
      plans,
      stats: { products: products.length, fromCache: 0, fetched: products.length, notFound, catalog },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), plans: [] };
  }
}
