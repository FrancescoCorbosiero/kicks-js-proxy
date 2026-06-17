"use server";

import { z } from "zod";
import { buildPlan } from "@core/core-spine";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { getMappingsForVariants } from "@/server/mappings/repo";
import { savePlan } from "@/server/plans/repo";
import { getCache } from "@/server/cache/redis";
import { fetchProductsCached } from "@/server/kicks/service";
import { resolveSkusViaCatalog } from "@/server/catalog/service";
import { dbCatalogStore } from "@/server/catalog/store";
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
 * M1 preview: fetch from KicksDB, resolve known mappings from the DB, run
 * buildPlan() per product, persist each plan, and return them for the diff table.
 * No writes to the store.
 */
export async function fetchAndPreview(input: PreviewInput): Promise<PreviewResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; "), plans: [] };
  }

  const config = await getActiveConfig();
  const market = parsed.data.market ?? config.source.market;
  const source = getSource(config);
  const cache = getCache();
  const ttl = config.source.cacheTtlSeconds;

  try {
    // SKU mode resolves through the persistent catalog (smart cache, upsert on
    // fresh fetch). Query mode uses the Redis whole-result cache.
    const result =
      parsed.data.mode === "skus"
        ? await resolveSkusViaCatalog(source, dbCatalogStore, parsed.data.skus!, market, ttl)
        : { ...(await fetchProductsCached(source, cache, parsed.data.query!, market, ttl)), notFound: [] as string[] };

    const out: PreviewPlan[] = [];
    for (const product of result.products) {
      const mappings = await getMappingsForVariants(
        product.variants.map((v) => v.stockxVariantId),
      );
      const plan = buildPlan(product, config, mappings);
      const { id, summary } = await savePlan(plan, market);
      out.push({ planId: id, market, title: product.title, brand: product.brand, plan, summary });
    }
    return {
      ok: true,
      plans: out,
      stats: {
        products: result.products.length,
        fromCache: result.fromCache,
        fetched: result.fetched,
        notFound: result.notFound,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), plans: [] };
  }
}
