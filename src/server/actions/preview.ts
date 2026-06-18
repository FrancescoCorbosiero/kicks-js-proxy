"use server";

import { z } from "zod";
import { buildPlan } from "@core/core-spine";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { resolveFromModel } from "@/server/store-json/match";
import { savePlan } from "@/server/plans/repo";
import { getCache } from "@/server/cache/redis";
import { fetchProductsCached } from "@/server/kicks/service";
import { resolveSkusViaCatalog } from "@/server/catalog/service";
import { dbCatalogStore } from "@/server/catalog/store";
import { euSize } from "@/lib/sizes";
import { isExactMatch } from "@/lib/match";
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

export interface FetchStats {
  products: number;
  fromCache: number;
  fetched: number;
  notFound: string[];
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
): Promise<PreviewPlan[]> {
  const out: PreviewPlan[] = [];
  for (const product of products) {
    const mappings = snapshot ? resolveFromModel(snapshot, product) : new Map();
    const plan = buildPlan(product, config, mappings);
    const { id, summary } = await savePlan(plan, market);

    const euSizes: Record<string, string> = {};
    for (const v of product.variants) {
      const eu = euSize(v.sizes);
      if (eu) euSizes[v.stockxVariantId] = eu;
    }

    out.push({
      planId: id,
      market,
      title: product.title,
      brand: product.brand,
      plan,
      summary,
      euSizes,
      exactMatch: term ? isExactMatch(term, product.sku, product.title) : false,
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
    const plans = await assemblePlans(result.products, config, snapshot, market, term);
    return {
      ok: true,
      plans,
      stats: {
        products: result.products.length,
        fromCache: result.fromCache,
        fetched: result.fetched,
        notFound: result.notFound,
      },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), plans: [] };
  }
}

/**
 * File-driven preview: take the SKUs straight from the uploaded store snapshot,
 * fetch their StockX prices from KicksDB, and preview the whole file at once.
 * This is the primary workflow — upload a file, work on it immediately.
 */
export async function previewFromStore(marketOverride?: string): Promise<PreviewResult> {
  const config = await getActiveConfig();
  const snapshot = await getActiveSnapshot();
  if (!snapshot) {
    return { ok: false, error: "Upload a store snapshot first.", plans: [] };
  }
  const skus = snapshot.products.map((p) => p.sku).filter((s): s is string => !!s);
  if (skus.length === 0) {
    return { ok: false, error: "The store snapshot has no products.", plans: [] };
  }

  const market = marketOverride ?? config.source.market;
  const source = getSource(config);

  try {
    const result = await resolveSkusViaCatalog(
      source,
      dbCatalogStore,
      skus,
      market,
      config.source.cacheTtlSeconds,
    );
    const plans = await assemblePlans(result.products, config, snapshot, market, null);
    return {
      ok: true,
      plans,
      stats: {
        products: result.products.length,
        fromCache: result.fromCache,
        fetched: result.fetched,
        notFound: result.notFound,
      },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), plans: [] };
  }
}
