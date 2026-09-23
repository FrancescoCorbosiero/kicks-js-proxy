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
import { gsFeedStatus, overlayGsOwnership } from "@/server/feeds/owner";
import {
  carryIdentifiers,
  DELISTED_VARIANT_PREFIX,
  delistedSource,
  fetchSecondarySource,
  mergeGsOwned,
} from "@/server/feeds/ownership";
import { getOverrides } from "@/server/overrides/repo";
import { activeFeedSkus, GS_FEED } from "@/server/feeds/repo";
import { followSaleRuleFor, manualPriceFor, type StoreOverrides } from "@/server/overrides/model";
import { isExactMatch } from "@/lib/match";
import { skuKey } from "@/lib/skus";
import { emptySummary, type PlanSummary, type PreviewPlan } from "@/lib/plan";
import { PREVIEW_PAGE_LIMIT, PreviewPage, pagePreviewPlans } from "@/lib/preview-page";
import {
  cancelSyncRun,
  commitSyncStep,
  createSyncRun,
  dropUncommittedPlans,
  failSyncRun,
  getSyncRun,
} from "@/server/sync/runs";
import type { StoreSyncRunRow } from "@/server/db/schema";
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
  /**
   * Store products the supplier feed has delisted (every row inactive): planned
   * at stock 0. An answer, not an absence — they never join `notFound`.
   */
  delisted?: number;
  /**
   * SKUs KicksDB failed to answer for (an outage mid-run). Not missing —
   * unanswered. They never join `notFound`.
   */
  unanswered?: number;
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
  delisted: ReadonlySet<string> = new Set(),
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
    const isDelisted = delisted.has(skuKey(product.sku));
    // A delisted product's stock is the feed's (0), even when KicksDB prices it:
    // saved as feed-owned so the apply's KicksDB cleanup, which makes priced
    // zero-stock variations available again, never undoes the zeroing.
    const source = isDelisted ? "goldensneakers" : (product.source ?? "kicksdb");
    const plan = buildPlan(product, config, mappings, {
      followSaleRule,
      // Feeds carry FINITE stock truth: quantities join the diff and are
      // written to the store. KicksDB never touches stock.
      manageStockFromSource: source !== "kicksdb",
      // No GS, no stock: the price may still come from KicksDB, the stock never.
      stockOverride: isDelisted ? 0 : undefined,
    });
    if (isDelisted) {
      for (const item of plan.items) {
        if (item.action === "skip" && item.stockxVariantId.startsWith(DELISTED_VARIANT_PREFIX)) {
          item.reason = "delisted by the supplier — already at 0";
        }
      }
    }
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

/** Everything one store chunk contributes to a run's report. */
interface ChunkOutcome {
  plans: PreviewPlan[];
  /** The chunk's misses (all of them — the caller caps the list). */
  notFound: string[];
  /** SKUs KicksDB could not answer for — kept apart from notFound. */
  unanswered: number;
  delisted: number;
  warning?: string;
  /** Null when catalog growth was skipped for this chunk. */
  catalog: { total: number; added: number; rejected: number } | null;
}

interface ChunkContext {
  config: import("@core/config").AppConfig;
  market: string;
  source: ReturnType<typeof getSource>;
  overrides: StoreOverrides;
  runId: string;
  seen: Set<string>;
  /**
   * The GS feed is in use on this install. Then a KicksDB failure never sinks
   * the run — whichever slice it lands in — because the feed products are
   * still plannable; its SKUs are reported as unanswered instead.
   */
  feedInUse: boolean;
}

/** Whether the GS feed carries anything at all — decides if KicksDB is the sole source. */
async function feedInUse(): Promise<boolean> {
  return (await activeFeedSkus(GS_FEED)).size > 0;
}

/**
 * Plan ONE slice of the store's SKUs and persist its plans under the run. The
 * unit both the one-shot preview and the stepped sync are made of.
 */
async function previewStoreChunk(part: string[], ctx: ChunkContext): Promise<ChunkOutcome> {
  const { config, market, source, overrides, runId, seen } = ctx;
  // OWNERSHIP FIRST. A feed-owned product's prices, sizes and stock come
  // from the local feed tables, so asking KicksDB about it is pointless at
  // best: on a supplier-only store it is hundreds of SKUs KicksDB has never
  // heard of, and a failing batch used to throw and take the whole sync down
  // with it — the feed sitting right there in the DB, unread.
  const { owned, delisted } = await gsFeedStatus(part, market, overrides);
  // Delisted SKUs still go to KicksDB — for a PRICE only (their stock is 0
  // whatever it answers).
  const kicksSkus = part.filter((s) => !owned.has(skuKey(s)));
  // The store products THIS chunk matches against — keyed by canonical
  // SKU, which is exactly what resolveFromModel wants as its index.
  const storeIndex = await getSnapshotProductsBySkus(part);

  // Bulk endpoint (show_sizes) returns EU sizes + prices in one call, chunked at
  // 50 SKUs. Product names come from the snapshot (the bulk response carries
  // no title/brand).
  const secondary = await fetchSecondarySource(kicksSkus, {
    // The delisted are plannable without KicksDB too (stock 0 needs no price).
    ownedCount: owned.size + delisted.size,
    soleSource: !ctx.feedInUse && owned.size + delisted.size === 0,
    configured: kicksdbConfigured(),
    fetch: (p) => source.getPricesBatch(p, market),
    describeError: errMessage,
  });
  const fetched = secondary.products;

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
  const merged = mergeGsOwned(enriched, owned).products;

  // Delisting: every store size of a product the supplier dropped is planned
  // at stock 0 — KicksDB variants kept for their price when it covers the
  // SKU, bare store sizes for the rest.
  const products: typeof merged = [];
  const delistedProducts: typeof merged = [];
  const pricedDelisted = new Map<string, (typeof merged)[number]>();
  for (const p of merged) {
    if (delisted.has(skuKey(p.sku))) pricedDelisted.set(skuKey(p.sku), p);
    else products.push(p);
  }
  for (const s of part) {
    const key = skuKey(s);
    if (!delisted.has(key)) continue;
    const store = storeIndex.get(key);
    const p = store ? delistedSource(s, store, pricedDelisted.get(key), market) : null;
    if (p) delistedProducts.push(p);
  }

  const returned = new Set(products.map((p) => skuKey(p.sku)));
  const unasked = new Set(secondary.unanswered.map(skuKey));
  const notFound = part.filter(
    (s) => !returned.has(skuKey(s)) && !delisted.has(skuKey(s)) && !unasked.has(skuKey(s)),
  );
  // A delisted SKU KicksDB did not answer is still zeroed — it counts as delisted.
  const unanswered = part.filter((s) => unasked.has(skuKey(s)) && !delisted.has(skuKey(s))).length;

  // Grow the ever-increasing catalog: GET-verify the brand-new SKUs the bulk
  // call returned and add only those fetchable on KicksDB (feed-owned
  // products are excluded — the catalog stays KicksDB-pure). Best-effort — a
  // catalog failure must never break the preview.
  let catalog: ChunkOutcome["catalog"] = null;
  try {
    const growth = await growCatalogFromSkus(
      source,
      dbCatalogStore,
      [...products, ...pricedDelisted.values()]
        .filter((p) => (p.source ?? "kicksdb") === "kicksdb")
        .map((p) => p.sku),
      market,
    );
    catalog = { total: growth.total, added: growth.added, rejected: growth.rejected.length };
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
    [...products, ...delistedProducts],
    config,
    storeIndex,
    market,
    null,
    overrides,
    runId,
    seen,
    delisted,
  );
  return { plans, notFound, unanswered, delisted: delisted.size, warning: secondary.warning, catalog };
}

/** The SKUs a store preview walks: the override (deduped), else the snapshot's. */
async function storePreviewSkus(skusOverride?: string[]): Promise<string[] | PreviewResult> {
  // The SKU LIST, not the store. The snapshot is one jsonb row holding every
  // product — reading it here to learn which SKUs exist, and to match against
  // them, kept ~150 MB of object graph alive for the whole run. The list comes
  // out of SQL already deduped by canonical key, and each chunk reads back
  // only the products it is about to match.
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
  return skus;
}

/**
 * File-driven preview: fetch StockX prices for a set of SKUs and preview them
 * against the uploaded store snapshot. With no `skusOverride` it previews the
 * whole file (the primary workflow). With one — e.g. a selection from the KicksDB
 * catalog — it previews just those SKUs, still matched to the snapshot so the
 * export stays a valid Woo re-import.
 *
 * ONE server action for the whole store: fine for a selection, too long for a
 * whole shop on a slow source — the Sync tab walks the store with
 * startStoreSync / advanceStoreSync instead.
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
  const skus = await storePreviewSkus(skusOverride);
  if (!Array.isArray(skus)) return skus;

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
    let catalog: CatalogStats | undefined;
    let delistedTotal = 0;
    let unansweredTotal = 0;
    const feed = await feedInUse();

    for (const part of chunk(skus, PREVIEW_CHUNK)) {
      const out = await previewStoreChunk(part, {
        config,
        market,
        source,
        overrides,
        runId,
        seen,
        feedInUse: feed,
      });
      unansweredTotal += out.unanswered;
      warning ??= out.warning;
      notFoundTotal += out.notFound.length;
      for (const s of out.notFound) if (notFound.length < NOT_FOUND_LIMIT) notFound.push(s);
      delistedTotal += out.delisted;
      if (out.catalog) {
        catalog = {
          total: out.catalog.total,
          added: (catalog?.added ?? 0) + out.catalog.added,
          rejected: (catalog?.rejected ?? 0) + out.catalog.rejected,
        };
      }
      planned += out.plans.length;
      for (const p of out.plans) addSummary(totals, p.summary);
      page.add(out.plans);
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
        delisted: delistedTotal,
        unanswered: unansweredTotal,
        catalog,
      },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), plans: [] };
  }
}

/* ------------------------------------------------------------------ */
/* The stepped store sync                                              */
/* ------------------------------------------------------------------ */

/**
 * SKUs one advance step plans. Small on purpose: a step is one server action,
 * and it has to come back well inside any request timeout even when every SKU
 * goes to KicksDB (bulk prices + catalog GET-verification of the new ones).
 * The memory knee above is irrelevant at this size.
 */
const SYNC_STEP_SKUS = 250;

export interface StoreSyncProgress {
  runId: string;
  status: StoreSyncRunRow["status"];
  /** SKUs planned so far, of `total`. */
  cursor: number;
  total: number;
  done: boolean;
  error: string | null;
  /**
   * The plans THIS step produced (a page of them — the browser keeps the
   * run's best page itself). Empty on a status-only answer.
   */
  plans: PreviewPlan[];
  /** Set once `done`: the whole run's report, exactly what previewFromStore returns. */
  result?: PreviewResult;
}

function syncProgress(
  run: StoreSyncRunRow,
  plans: PreviewPlan[] = [],
): StoreSyncProgress {
  const done = run.status === "done";
  return {
    runId: run.id,
    status: run.status,
    cursor: run.cursor,
    total: run.skus.length,
    done,
    error: run.error,
    plans,
    result: done ? syncRunResult(run) : undefined,
  };
}

/** The report of a finished run. `plans` is left to the browser, which holds the page. */
function syncRunResult(run: StoreSyncRunRow): PreviewResult {
  return {
    ok: true,
    warning: run.warning ?? undefined,
    runId: run.id,
    plans: [],
    totals: run.totals,
    products: run.planned,
    stats: {
      products: run.planned,
      fromCache: 0,
      fetched: run.planned,
      notFound: run.notFound,
      notFoundTotal: run.notFoundTotal,
      delisted: run.delisted,
      unanswered: run.unanswered,
      catalog: run.catalog ?? undefined,
    },
  };
}

/**
 * Open a stepped sync over the store (or a SKU selection of it). Always a NEW
 * run: a sync is a reading of the store at one moment, and a half-finished one
 * from earlier describes a store that may have moved since.
 */
export async function startStoreSync(
  marketOverride?: string,
  skusOverride?: string[],
): Promise<{ ok: boolean; error?: string; progress?: StoreSyncProgress }> {
  try {
    const config = await getActiveConfig();
    const skus = await storePreviewSkus(skusOverride);
    if (!Array.isArray(skus)) return { ok: false, error: skus.error };
    await prunePlans(); // best-effort retention: plans are per-run scratch data
    const run = await createSyncRun(marketOverride ?? config.source.market, skus);
    return { ok: true, progress: syncProgress(run) };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

/**
 * Plan the next SYNC_STEP_SKUS of a running sync. The cursor and the report's
 * counts move only once the step's plans are saved, so a step that dies
 * half-way (a timeout, a crash) is simply planned again by the next call —
 * its orphaned plans are dropped first.
 */
export async function advanceStoreSync(
  runId: string,
): Promise<{ ok: boolean; error?: string; progress?: StoreSyncProgress }> {
  try {
    const run = await getSyncRun(runId);
    if (!run) return { ok: false, error: "Unknown sync run." };
    if (run.status !== "running") return { ok: true, progress: syncProgress(run) };

    await dropUncommittedPlans(run);
    const part = run.skus.slice(run.cursor, run.cursor + SYNC_STEP_SKUS);
    let out: ChunkOutcome;
    try {
      const config = await getActiveConfig();
      out = await previewStoreChunk(part, {
        config,
        market: run.market,
        source: getSource(config),
        overrides: await getOverrides(),
        runId,
        seen: new Set<string>(),
        feedInUse: await feedInUse(),
      });
    } catch (e) {
      // The step had an answer to give and could not: the run is not a
      // reading of the store any more, and must not be applied as one.
      return { ok: true, progress: syncProgress(await failSyncRun(runId, errMessage(e))) };
    }

    const totals = { ...run.totals };
    for (const p of out.plans) addSummary(totals, p.summary);
    const next = await commitSyncStep(run, {
      cursor: run.cursor + part.length,
      planned: run.planned + out.plans.length,
      totals,
      notFound: [...run.notFound, ...out.notFound].slice(0, NOT_FOUND_LIMIT),
      notFoundTotal: run.notFoundTotal + out.notFound.length,
      delisted: run.delisted + out.delisted,
      unanswered: run.unanswered + out.unanswered,
      warning: run.warning ?? out.warning ?? null,
      catalog: out.catalog
        ? {
            total: out.catalog.total,
            added: (run.catalog?.added ?? 0) + out.catalog.added,
            rejected: (run.catalog?.rejected ?? 0) + out.catalog.rejected,
          }
        : run.catalog,
    });
    return { ok: true, progress: syncProgress(next, pagePreviewPlans(out.plans)) };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

/** Stop a running sync. Its plans stay (pruned like any run) but it can never be applied. */
export async function cancelStoreSync(runId: string): Promise<{ ok: boolean }> {
  await cancelSyncRun(runId);
  return { ok: true };
}
