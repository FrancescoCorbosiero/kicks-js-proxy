"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildPlan } from "@core/core-spine";
import { getActiveConfig } from "@/server/config/repo";
import { getSource, kicksdbConfigured } from "@/server/adapters/kicksdb";
import {
  getSnapshotInfo,
  getSnapshotProductsBySkus,
  listStoreSkuSpellings,
} from "@/server/store-json/repo";
import { resolveFromModel, sourceEuSize } from "@/server/store-json/match";
import { savePlans, prunePlans, type PlanToSave } from "@/server/plans/repo";
import { getCache } from "@/server/cache/redis";
import { fetchProductsCached } from "@/server/kicks/service";
import { resolveSkusViaCatalog, growCatalogFromSkus } from "@/server/catalog/service";
import { dbCatalogStore } from "@/server/catalog/store";
import { getAnyBySkus } from "@/server/catalog/repo";
import { gsOwnedProducts, overlayGsOwnership } from "@/server/feeds/owner";
import { carryIdentifiers, fetchSecondarySource, mergeGsOwned } from "@/server/feeds/ownership";
import { getOverrides } from "@/server/overrides/repo";
import { followSaleRuleFor, manualPriceFor, type StoreOverrides } from "@/server/overrides/model";
import { isExactMatch } from "@/lib/match";
import { skuKey } from "@/lib/skus";
import { emptySummary, type PlanSummary, type PreviewPlan } from "@/lib/plan";
import { PREVIEW_PAGE_LIMIT, PreviewPage } from "@/lib/preview-page";
import type { StoreProductModel } from "@/server/store-json/model";

/**
 * SKUs resolved per pass. Bounds the server's own working set, not just the wire.
 *
 * Measured on a 21 800-product store, because the two costs pull opposite ways:
 * a smaller chunk holds less at once, but each one re-reads the store's SKUs
 * out of the single jsonb row the snapshot lives in.
 *
 *    500 -> peak  187 MB, 69 s
 *   2000 -> peak  534 MB, 29 s
 *   5000 -> peak  854 MB, 27 s
 *
 * 2000 is the knee: five seconds off 5000's time for 320 MB less. What matters
 * is that peak is a function of THIS number and not of the store — it is the
 * same 534 MB whether the shop has 20 000 products or 200 000.
 */
const PREVIEW_CHUNK = 2000;

/** Misses listed for the copy button. The true count is reported separately. */
const NOT_FOUND_LIMIT = 2000;

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
  /** Misses in total — `notFound` is capped for the wire. */
  notFoundTotal?: number;
  catalog?: CatalogStats;
}

export interface PreviewResult {
  ok: boolean;
  error?: string;
  /**
   * The run succeeded but a source was degraded — e.g. KicksDB is unreachable
   * or unconfigured while the feed-owned products came through fine. Shown as
   * a warning; `ok` stays true because the plans below are real.
   */
  warning?: string;
  /**
   * The persisted run these plans belong to. The apply is given THIS, not a
   * list of everything it should touch, so a run larger than the page is still
   * applied whole.
   */
  runId?: string;
  /** A page of the run, products with the most to do first. */
  plans: PreviewPlan[];
  /** Counts over the WHOLE run — never over the page. */
  totals?: PlanSummary;
  /** Products in the whole run. `plans.length` is what is shown of it. */
  products?: number;
  stats?: FetchStats;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function addSummary(into: PlanSummary, from: PlanSummary): void {
  into.update += from.update;
  into.create += from.create;
  into.noop += from.noop;
  into.skip += from.skip;
}

/**
 * Build + persist a PreviewPlan per product of ONE chunk: match against the
 * store snapshot index, run buildPlan, attach EU sizes and the exact-match flag.
 */
async function planChunk(
  products: import("@core/core-spine").SourceProduct[],
  config: import("@core/config").AppConfig,
  storeIndex: Map<string, StoreProductModel> | null,
  market: string,
  term: string | null,
  overrides: StoreOverrides,
  runId: string,
  seen: Set<string>,
): Promise<PreviewPlan[]> {
  // One plan per SKU. Two products for the same SKU (a source returning the
  // style code twice, a feed row overlaid onto its own catalog entry) would
  // each match the SAME store variations, so the apply would write every price
  // twice and the UI would show two rows sharing one identity.
  const planned: {
    toSave: PlanToSave;
    product: import("@core/core-spine").SourceProduct;
    euSizes: Record<string, string>;
    manualPrices: Record<string, number>;
    followSaleRule: boolean;
  }[] = [];

  for (const product of products) {
    if (seen.has(skuKey(product.sku))) continue;
    seen.add(skuKey(product.sku));
    const mappings = storeIndex ? resolveFromModel(storeIndex, product) : new Map();

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
    const source = product.source ?? "kicksdb";
    const plan = buildPlan(product, config, mappings, {
      followSaleRule,
      // Feeds carry FINITE stock truth: quantities join the diff and are
      // written to the store. KicksDB never touches stock.
      manageStockFromSource: source !== "kicksdb",
    });
    planned.push({ toSave: { plan, source }, product, euSizes, manualPrices, followSaleRule });
  }

  const saved = await savePlans(
    planned.map((p) => p.toSave),
    market,
    runId,
  );

  return planned.map((p, i) => ({
    planId: saved[i].id,
    market,
    sku: p.product.sku,
    title: p.product.title,
    brand: p.product.brand,
    source: p.toSave.source,
    plan: p.toSave.plan,
    summary: saved[i].summary,
    euSizes: p.euSizes,
    exactMatch: term ? isExactMatch(term, p.product.sku, p.product.title) : false,
    followSaleRule: p.followSaleRule,
    manualPrices: p.manualPrices,
  }));
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
  const overrides = await getOverrides();
  const cache = getCache();
  const ttl = config.source.cacheTtlSeconds;

  try {
    // Without a KicksDB account there is nothing to resolve there: the feed
    // overlay below is the whole answer, and a query (which only KicksDB can
    // serve) is simply empty rather than an error.
    const empty: {
      products: import("@core/core-spine").SourceProduct[];
      fromCache: number;
      fetched: number;
      notFound: string[];
      failed: import("@/server/catalog/service").SkuFailure[];
    } = { products: [], fromCache: 0, fetched: 0, notFound: [], failed: [] };
    // SKU mode resolves through the persistent catalog (smart cache, upsert on
    // fresh fetch). Query mode uses the Redis whole-result cache.
    const result = !kicksdbConfigured()
      ? { ...empty, notFound: parsed.data.mode === "skus" ? [...parsed.data.skus!] : [] }
      : parsed.data.mode === "skus"
        ? await resolveSkusViaCatalog(source, dbCatalogStore, parsed.data.skus!, market, ttl)
        : {
            ...(await fetchProductsCached(source, cache, parsed.data.query!, market, ttl)),
            notFound: [] as string[],
            failed: [] as import("@/server/catalog/service").SkuFailure[],
          };

    // Ownership: GS-owned SKUs swap their variant set + pricing to the feed.
    const overlayScope =
      parsed.data.mode === "skus" ? parsed.data.skus! : result.products.map((p) => p.sku);
    const overlaid = await overlayGsOwnership(result.products, overlayScope, market, overrides);
    result.products = overlaid.products;
    result.notFound = result.notFound.filter((s) => !overlaid.gsSkus.has(skuKey(s)));
    result.failed = result.failed.filter((f) => !overlaid.gsSkus.has(skuKey(f.sku)));

    // A lookup that errored is not a SKU that does not exist. It never joins
    // notFound (the card there offers to copy "the missing ones" — these are
    // not missing, they are unanswered) and says so on its own line instead.
    const skuWarning =
      result.failed.length > 0
        ? `${result.failed.length} SKU non verificati: KicksDB non ha risposto ` +
          `(${result.failed[0].error}). Riprovali.`
        : undefined;

    const term = parsed.data.mode === "query" ? parsed.data.query! : null;
    // Only the store products these results match against — read once the
    // result set is known, which in query mode is the first moment it can be.
    const storeIndex = await getSnapshotProductsBySkus(result.products.map((p) => p.sku));
    await prunePlans(); // best-effort retention: plans are per-run scratch data
    const runId = randomUUID();
    const totals = emptySummary();
    const page = new PreviewPage<PreviewPlan>(PREVIEW_PAGE_LIMIT);
    // This mode is capped at 500 SKUs by the schema, so it is one pass — but it
    // goes through the same run machinery, so a plan id means the same thing
    // wherever it came from.
    const plans = await planChunk(
      result.products,
      config,
      storeIndex,
      market,
      term,
      overrides,
      runId,
      new Set<string>(),
    );
    for (const p of plans) addSummary(totals, p.summary);
    page.add(plans);

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
      runId,
      warning: skuWarning,
      plans: page.take(),
      totals,
      products: plans.length,
      stats: {
        products: result.products.length,
        fromCache: result.fromCache,
        fetched: result.fetched,
        notFound: result.notFound.slice(0, NOT_FOUND_LIMIT),
        notFoundTotal: result.notFound.length,
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
 * export stays a valid Woo re-import.
 *
 * The store is walked in chunks. Resolving every SKU at once meant the whole
 * catalog's worth of source products, mappings and plans were live at the same
 * moment — which is what ran the dev server out of heap on a large shop. Only
 * the counts, and the page the browser is sent, survive a chunk.
 */
export async function previewFromStore(
  marketOverride?: string,
  skusOverride?: string[],
): Promise<PreviewResult> {
  const config = await getActiveConfig();
  // The SKU LIST, not the store. The snapshot is one jsonb row holding every
  // product — reading it here to learn which SKUs exist, and to match against
  // them, kept ~150 MB of object graph alive for the whole run. The list comes
  // out of SQL already deduped by canonical key, and each chunk below reads
  // back only the products it is about to match.
  if ((await getSnapshotInfo()) == null) {
    return { ok: false, error: "Upload a store snapshot first.", plans: [] };
  }
  const skus =
    skusOverride && skusOverride.length > 0
      ? [...new Map(skusOverride.map((s) => [skuKey(s), s])).values()]
      : await listStoreSkuSpellings();
  if (skus.length === 0) {
    return { ok: false, error: "The store snapshot has no products.", plans: [] };
  }

  const market = marketOverride ?? config.source.market;
  const source = getSource(config);
  const overrides = await getOverrides();

  try {
    await prunePlans(); // best-effort retention: plans are per-run scratch data
    const runId = randomUUID();
    const page = new PreviewPage<PreviewPlan>(PREVIEW_PAGE_LIMIT);
    const totals = emptySummary();
    const seen = new Set<string>();
    const notFound: string[] = [];
    let notFoundTotal = 0;
    let planned = 0;
    let warning: string | undefined;
    let catalogTotal = 0;
    let catalogAdded = 0;
    let catalogRejected = 0;
    let catalogSeen = false;

    for (const part of chunk(skus, PREVIEW_CHUNK)) {
      // OWNERSHIP FIRST. A feed-owned product's prices, sizes and stock come
      // from the local feed tables, so asking KicksDB about it is pointless at
      // best: on a supplier-only store it is hundreds of SKUs KicksDB has never
      // heard of, and a failing batch used to throw and take the whole sync down
      // with it — the feed sitting right there in the DB, unread.
      const owned = await gsOwnedProducts(part, market, overrides);
      const kicksSkus = part.filter((s) => !owned.has(skuKey(s)));
      // The store products THIS chunk matches against — keyed by canonical
      // SKU, which is exactly what resolveFromModel wants as its index.
      const storeIndex = await getSnapshotProductsBySkus(part);

      // Bulk endpoint (show_sizes) returns EU sizes + prices in one call, chunked at
      // 50 SKUs. Product names come from the snapshot (the bulk response carries
      // no title/brand).
      const secondary = await fetchSecondarySource(kicksSkus, {
        ownedCount: owned.size,
        configured: kicksdbConfigured(),
        fetch: (p) => source.getPricesBatch(p, market),
        describeError: errMessage,
      });
      const fetched = secondary.products;
      warning ??= secondary.warning;

      for (const p of fetched) {
        const name = storeIndex.get(skuKey(p.sku))?.name;
        if (name) p.title = name;
      }
      // The bulk price endpoint carries no identifiers; the catalog (filled from
      // the per-product endpoint) does. Without this the sync could never write
      // a GTIN for a KicksDB product, only for feed-owned ones.
      const enriched = carryIdentifiers(
        fetched,
        fetched.length > 0
          ? await getAnyBySkus(market, fetched.map((p) => p.sku)).catch(() => new Map())
          : new Map(),
      );

      // Ownership BEFORE not-found accounting: a GS-owned SKU KicksDB doesn't
      // carry is covered by the feed, not missing.
      const products = mergeGsOwned(enriched, owned).products;
      const returned = new Set(products.map((p) => skuKey(p.sku)));
      for (const s of part) {
        if (returned.has(skuKey(s))) continue;
        notFoundTotal += 1;
        if (notFound.length < NOT_FOUND_LIMIT) notFound.push(s);
      }

      // Grow the ever-increasing catalog: GET-verify the brand-new SKUs the bulk
      // call returned and add only those fetchable on KicksDB (feed-owned
      // products are excluded — the catalog stays KicksDB-pure). Best-effort — a
      // catalog failure must never break the preview.
      try {
        const growth = await growCatalogFromSkus(
          source,
          dbCatalogStore,
          products.filter((p) => (p.source ?? "kicksdb") === "kicksdb").map((p) => p.sku),
          market,
        );
        catalogTotal = growth.total;
        catalogAdded += growth.added;
        catalogRejected += growth.rejected.length;
        catalogSeen = true;
        // Growth here is best-effort, but an unanswered lookup is not a
        // rejection and must not be counted as one — nor silently dropped.
        if (growth.failed.length > 0) {
          console.warn(
            `[catalog] ${growth.failed.length} SKU(s) unverified (KicksDB did not answer): ` +
              growth.failed.slice(0, 5).map((f) => f.sku).join(", "),
          );
        }
      } catch (e) {
        console.warn("[catalog] growth skipped:", errMessage(e));
      }

      const plans = await planChunk(
        products,
        config,
        storeIndex,
        market,
        null,
        overrides,
        runId,
        seen,
      );
      planned += plans.length;
      for (const p of plans) addSummary(totals, p.summary);
      page.add(plans);
    }

    return {
      ok: true,
      warning,
      runId,
      plans: page.take(),
      totals,
      products: planned,
      stats: {
        products: planned,
        fromCache: 0,
        fetched: planned,
        notFound,
        notFoundTotal,
        catalog: catalogSeen
          ? { total: catalogTotal, added: catalogAdded, rejected: catalogRejected }
          : undefined,
      },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), plans: [] };
  }
}
