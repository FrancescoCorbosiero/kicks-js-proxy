"use server";

import { resolveEffectiveRule } from "@core/config";
import {
  computePrice,
  medianTierAsk,
  type SourceProduct,
  type SourceVariant,
} from "@core/core-spine";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { getCatalogEntry } from "@/server/catalog/repo";
import {
  parsePrice,
  resolveFromModel,
  sourceEuSize,
  variationEuSize,
  readTaglia,
} from "@/server/store-json/match";
import { skuKey } from "@/lib/skus";

export interface DebugResult {
  ok: boolean;
  error?: string;
  json?: string;
}

/**
 * Diagnose why store matching produces no updates: for the first snapshot SKU,
 * show the store variation sizes next to the StockX variant sizes (raw +
 * normalized + computed EU), and the resulting match count.
 */
export async function debugMatch(): Promise<DebugResult> {
  const config = await getActiveConfig();
  const snapshot = await getActiveSnapshot();
  if (!snapshot || snapshot.products.length === 0) {
    return { ok: false, error: "No store snapshot loaded." };
  }

  const prod = snapshot.products[0];
  const market = config.source.market;
  const source = getSource(config);

  try {
    const raw = await source.fetchProductsRaw(prod.sku, market);
    const products = await source.getProduct(prod.sku, market, 1);
    const sx = products.find((p) => skuKey(p.sku) === skuKey(prod.sku)) ?? products[0];

    const storeSample = prod.variations.slice(0, 6).map((v) => ({
      sku: v.sku,
      pa_taglia: readTaglia(v),
      eu: variationEuSize(prod.sku, v),
    }));
    const stockxSample = sx
      ? sx.variants.slice(0, 6).map((v) => ({
          sizeLabel: v.sizeLabel,
          sizeType: v.sizeType,
          sizes: v.sizes,
          eu: sourceEuSize(v),
        }))
      : [];
    const matched = sx ? resolveFromModel(snapshot, sx).size : 0;

    const rawFirstVariant =
      (raw as { data?: { variants?: unknown[] }[] })?.data?.[0]?.variants?.[0] ?? null;

    return {
      ok: true,
      json: JSON.stringify(
        {
          storeSku: prod.sku,
          market,
          stockxFound: !!sx,
          stockxVariantCount: sx?.variants.length ?? 0,
          matchedVariants: matched,
          storeSample,
          stockxSample,
          rawFirstVariant,
        },
        null,
        2,
      ),
    };
  } catch (e) {
    const cause = (e as { cause?: { message?: string } })?.cause;
    return { ok: false, error: cause?.message ?? (e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Dump the RAW batch-prices response for the first few snapshot SKUs, so we can
 * wire POST /stockx/prices correctly (the fast path for large files).
 */
export async function debugBulkPrices(): Promise<DebugResult> {
  const config = await getActiveConfig();
  const snapshot = await getActiveSnapshot();
  if (!snapshot || snapshot.products.length === 0) {
    return { ok: false, error: "No store snapshot loaded." };
  }
  const skus = snapshot.products.slice(0, 5).map((p) => p.sku).filter(Boolean);
  const source = getSource(config);
  try {
    const raw = await source.fetchPricesRaw(skus, config.source.market);
    return { ok: true, json: JSON.stringify({ requestedSkus: skus, market: config.source.market, raw }, null, 2) };
  } catch (e) {
    const cause = (e as { cause?: { message?: string } })?.cause;
    return { ok: false, error: cause?.message ?? (e instanceof Error ? e.message : String(e)) };
  }
}

/* ------------------------------------------------------------------ */
/* Per-SKU price audit: where does each size's price actually come from */
/* ------------------------------------------------------------------ */

export interface PriceAuditRow {
  sizeLabel: string;
  sizeType: string;
  euSize: string | null;
  /** Ask in the catalog cache (what sync/drawer price from), configured tier. */
  storedAsk: number | null;
  storedAsks: number;
  /** Ask from a LIVE GET /stockx/products call, configured tier. */
  liveProductAsk: number | null;
  /** RAW rows from a LIVE POST /stockx/prices call — uncollapsed, every tier. */
  liveBulkRows: string[];
  /** The live bulk response carried >1 differing price for the configured tier. */
  bulkConflict: boolean;
  /** Shelf price the rules produce from the stored / live ask. */
  proposedFromStored: number | null;
  proposedFromLive: number | null;
  /** Current price on the store (snapshot), matched by EU size. */
  storePrice: number | null;
}

export interface PriceAuditResult {
  ok: boolean;
  error?: string;
  sku?: string;
  market?: string;
  deliveryType?: string;
  /** Catalog-cache freshness/provenance, so a stale cache is visible. */
  cacheFetchedAt?: string;
  cacheSource?: string;
  /** Live API calls that failed — the live columns are missing, not empty. */
  liveError?: string;
  rows?: PriceAuditRow[];
}

/** Loose view of the raw bulk response — deliberately schema-free so unknown
 *  tiers and duplicate rows stay VISIBLE instead of being normalized away. */
interface RawBulkRow {
  id?: string;
  size?: string | number;
  size_type?: string;
  price?: number;
  asks?: number;
  type?: string;
}

/**
 * Audit one SKU's price chain end to end: catalog cache vs LIVE product
 * endpoint vs LIVE bulk endpoint (raw rows, all tiers, duplicates included)
 * vs the current store price — per size, plus the shelf price the pricing
 * rules would produce from each ask. Built to answer "why is size X priced
 * absurdly low" in one click from the product drawer.
 */
export async function auditPrices(input: { sku: string }): Promise<PriceAuditResult> {
  const sku = (input?.sku ?? "").trim();
  if (!sku) return { ok: false, error: "missing sku" };

  try {
    const config = await getActiveConfig();
    const market = config.source.market;
    const tier = config.source.defaultDeliveryType;
    const source = getSource(config);
    const key = skuKey(sku);

    const [entry, liveProducts, rawBulk, snapshot] = await Promise.all([
      getCatalogEntry(market, key),
      source.getProduct(key, market, 1).catch((e) => e as Error),
      source.fetchPricesRaw([key], market).catch((e) => e as Error),
      getActiveSnapshot().catch(() => null),
    ]);

    const liveProduct =
      Array.isArray(liveProducts)
        ? (liveProducts.find((p) => skuKey(p.sku) === key) ?? null)
        : null;
    const productError = liveProducts instanceof Error ? liveProducts.message : null;

    // Raw bulk rows for this SKU, grouped by variant id — every entry, every
    // tier, unknown types included.
    const bulkByVariant = new Map<string, RawBulkRow[]>();
    const bulkError: string | null = rawBulk instanceof Error ? rawBulk.message : null;
    if (!(rawBulk instanceof Error)) {
      const data = (rawBulk as { data?: unknown }).data;
      for (const p of Array.isArray(data) ? data : []) {
        const prod = p as { product_id?: string; sku?: string; variants?: unknown };
        const matches =
          (prod.sku && skuKey(String(prod.sku)) === key) ||
          (entry && prod.product_id === entry.product.stockxId);
        if (!matches) continue;
        for (const v of Array.isArray(prod.variants) ? (prod.variants as RawBulkRow[]) : []) {
          if (!v?.id) continue;
          const list = bulkByVariant.get(v.id) ?? [];
          list.push(v);
          bulkByVariant.set(v.id, list);
        }
      }
    }

    // Current store prices by EU size.
    const storeByEu = new Map<string, number>();
    const storeProd = snapshot?.products.find((p) => skuKey(p.sku) === key);
    if (storeProd) {
      for (const vrt of storeProd.variations) {
        const eu = variationEuSize(storeProd.sku, vrt);
        const price = parsePrice(vrt.regular_price);
        if (eu && price != null) storeByEu.set(eu, price);
      }
    }

    const tierAsk = (v: SourceVariant | undefined): { ask: number | null; asks: number } => {
      const offer = v?.offers.find((o) => o.deliveryType === tier);
      return { ask: offer?.lowestAsk ?? null, asks: offer?.asks ?? 0 };
    };
    const propose = (product: SourceProduct | null, v: SourceVariant | undefined): number | null => {
      if (!product || !v) return null;
      const rule = resolveEffectiveRule(product, v, config);
      return rule
        ? computePrice(v, rule, { medianAsk: medianTierAsk(product, rule.sourceDeliveryType) })
        : null;
    };

    // One audit row per variant: union of stored and live variant ids.
    const storedVariants = new Map((entry?.product.variants ?? []).map((v) => [v.stockxVariantId, v]));
    const liveVariants = new Map((liveProduct?.variants ?? []).map((v) => [v.stockxVariantId, v]));
    const ids = [...new Set([...storedVariants.keys(), ...liveVariants.keys()])];

    const rows: PriceAuditRow[] = ids.map((id) => {
      const stored = storedVariants.get(id);
      const live = liveVariants.get(id);
      const ref = live ?? stored!;
      const eu = sourceEuSize(ref) ?? null;
      const bulkRows = bulkByVariant.get(id) ?? [];
      const bulkTierPrices = [
        ...new Set(
          bulkRows
            .filter((r) => r.type === tier && typeof r.price === "number" && r.price > 0)
            .map((r) => r.price as number),
        ),
      ];
      const storedTier = tierAsk(stored);
      return {
        sizeLabel: ref.sizeLabel,
        sizeType: ref.sizeType,
        euSize: eu,
        storedAsk: storedTier.ask,
        storedAsks: storedTier.asks,
        liveProductAsk: tierAsk(live).ask,
        liveBulkRows: bulkRows.map(
          (r) => `${r.type ?? "?"} ${typeof r.price === "number" ? r.price : "—"} ×${r.asks ?? 0}`,
        ),
        bulkConflict: bulkTierPrices.length > 1,
        proposedFromStored: propose(entry?.product ?? null, stored),
        proposedFromLive: propose(liveProduct, live),
        storePrice: eu ? (storeByEu.get(eu) ?? null) : null,
      };
    });

    // EU-size order (numeric), sizeless rows last.
    rows.sort((a, b) => {
      const an = Number.parseFloat(a.euSize ?? a.sizeLabel);
      const bn = Number.parseFloat(b.euSize ?? b.sizeLabel);
      return (Number.isFinite(an) ? an : 999) - (Number.isFinite(bn) ? bn : 999);
    });

    if (rows.length === 0 && bulkError) return { ok: false, error: bulkError };

    const liveErrors = [
      productError ? `products: ${productError}` : null,
      bulkError ? `bulk: ${bulkError}` : null,
    ].filter((x): x is string => x != null);

    return {
      ok: true,
      sku: key,
      market,
      deliveryType: tier,
      cacheFetchedAt: entry?.fetchedAt,
      cacheSource: entry?.source,
      liveError: liveErrors.length > 0 ? liveErrors.join(" · ") : undefined,
      rows,
    };
  } catch (e) {
    const cause = (e as { cause?: { message?: string } })?.cause;
    return { ok: false, error: cause?.message ?? (e instanceof Error ? e.message : String(e)) };
  }
}
