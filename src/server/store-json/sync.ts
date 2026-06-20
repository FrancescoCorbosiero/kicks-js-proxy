import { buildPlan, renderSkuTemplate } from "@core/core-spine";
import type { SourceProduct, SourceVariant } from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { skuKey } from "@/lib/skus";
import { resolveFromModel, sourceEuSize, variationEuSize } from "./match";
import type { StoreModel, StoreProductModel, StoreVariation } from "./model";

/**
 * The four ways a round-trip apply may reconcile the store model against the
 * freshly priced StockX source:
 *
 *  - update_only — reprice existing matched variations only (the original,
 *    safest flow: only `regular_price`/GTIN change, nothing is added or removed).
 *  - create_only — add variations/products that StockX has but the store lacks;
 *    never touch existing rows.
 *  - upsert       — update_only + create_only.
 *  - replace      — upsert, and additionally REMOVE store variations whose EU
 *    size no longer exists on StockX (destructive: drops sold-out sizes).
 */
export type SyncMode = "update_only" | "create_only" | "upsert" | "replace";

export const SYNC_MODES: readonly SyncMode[] = [
  "update_only",
  "create_only",
  "upsert",
  "replace",
] as const;

export function isSyncMode(x: string): x is SyncMode {
  return (SYNC_MODES as readonly string[]).includes(x);
}

export interface SyncSummary {
  productsChanged: number;
  productsCreated: number;
  variationsUpdated: number;
  variationsCreated: number;
  variationsRemoved: number;
  gtinsWritten: number;
  /** Source variants we wanted to act on but couldn't (e.g. create with no EU size). */
  skipped: number;
}

export interface SyncOutcome extends SyncSummary {
  /** The complete model with every change merged in (for persisting the new store state). */
  full: StoreModel;
  /** Only the products that actually changed (the lean re-import file). */
  changed: StoreModel;
}

export interface SyncOptions {
  mode: SyncMode;
  /** SKU template for synthesized variations; defaults to the config's matching template. */
  skuTemplate?: string;
}

function emptySummary(): SyncSummary {
  return {
    productsChanged: 0,
    productsCreated: 0,
    variationsUpdated: 0,
    variationsCreated: 0,
    variationsRemoved: 0,
    gtinsWritten: 0,
    skipped: 0,
  };
}

/** Build a brand-new Woo variation row for a StockX variant. id 0 => "create on import". */
function newVariation(
  parentSku: string,
  product: SourceProduct,
  variant: SourceVariant,
  eu: string,
  price: number,
  template: string,
): StoreVariation {
  return {
    id: 0,
    sku: renderSkuTemplate(template, { sku: parentSku, brand: product.brand }, {
      sizeLabel: eu,
      sizeType: "eu",
    }),
    regular_price: price.toFixed(2),
    global_unique_id: variant.upc ?? null,
    attributes: { attribute_pa_taglia: eu },
  };
}

/**
 * Reconcile the store round-trip model against freshly priced StockX products.
 *
 * `sources` MUST already be limited to "searchable" SKUs (the ones KicksDB
 * resolved) — products absent here are never touched, which is exactly the
 * proxy-side strip the caller performs before invoking this. Never mutates input.
 */
export function applyRoundtripSync(
  model: StoreModel,
  sources: SourceProduct[],
  config: AppConfig,
  options: SyncOptions,
): SyncOutcome {
  const { mode } = options;
  const template = options.skuTemplate ?? config.matching.skuTemplate ?? "{sku}-{size}";

  const doUpdate = mode === "update_only" || mode === "upsert" || mode === "replace";
  const doCreate = mode === "create_only" || mode === "upsert" || mode === "replace";
  const doRemove = mode === "replace";

  const full: StoreModel = structuredClone(model);
  const byKey = new Map<string, StoreProductModel>();
  for (const p of full.products) byKey.set(skuKey(p.sku), p);

  const changed = new Set<StoreProductModel>();
  const summary = emptySummary();

  for (const product of sources) {
    const key = skuKey(product.sku);
    const existed = byKey.has(key);
    // Resolve against the live (cloned) model so freshly created parents are seen.
    const mappings = resolveFromModel(full, product);
    const plan = buildPlan(product, config, mappings);
    const variantById = new Map(product.variants.map((v) => [v.stockxVariantId, v]));

    for (const item of plan.items) {
      if (item.action === "update") {
        if (!doUpdate || item.storeVariationId == null || item.proposedPrice == null) continue;
        const parent = byKey.get(key);
        const vrt = parent?.variations.find((v) => v.id === item.storeVariationId);
        if (!vrt) continue;
        vrt.regular_price = item.proposedPrice.toFixed(2);
        summary.variationsUpdated += 1;
        if (item.upc && vrt.global_unique_id !== item.upc) {
          vrt.global_unique_id = item.upc;
          summary.gtinsWritten += 1;
        }
        if (parent) changed.add(parent);
      } else if (item.action === "create") {
        if (!doCreate || item.proposedPrice == null) continue;
        const v = variantById.get(item.stockxVariantId);
        const eu = v ? sourceEuSize(v) : null;
        if (!v || !eu) {
          summary.skipped += 1; // can't place a variation without an EU size
          continue;
        }
        let parent = byKey.get(key);
        if (!parent) {
          parent = { id: 0, sku: product.sku, name: product.title || null, variations: [] };
          full.products.push(parent);
          byKey.set(key, parent);
          summary.productsCreated += 1;
        }
        parent.variations.push(newVariation(parent.sku, product, v, eu, item.proposedPrice, template));
        summary.variationsCreated += 1;
        if (item.upc) summary.gtinsWritten += 1;
        changed.add(parent);
      }
      // noop / skip => intentionally nothing
    }

    // replace: drop store sizes StockX no longer lists (only for pre-existing products).
    if (doRemove && existed) {
      const parent = byKey.get(key);
      if (parent) {
        const live = new Set(
          product.variants.map((v) => sourceEuSize(v)).filter((e): e is string => !!e),
        );
        const before = parent.variations.length;
        parent.variations = parent.variations.filter((vrt) => {
          if (vrt.id === 0) return true; // just created
          const e = variationEuSize(parent.sku, vrt);
          if (!e) return true; // unknown size => never auto-remove
          return live.has(e);
        });
        const removed = before - parent.variations.length;
        if (removed > 0) {
          summary.variationsRemoved += removed;
          changed.add(parent);
        }
      }
    }
  }

  if (typeof full.product_count === "number") full.product_count = full.products.length;

  const changedProducts = full.products.filter((p) => changed.has(p));
  const changedModel: StoreModel = {
    ...full,
    products: changedProducts,
    ...(typeof full.product_count === "number" ? { product_count: changedProducts.length } : {}),
  };

  summary.productsChanged = changedProducts.length;
  return { ...summary, full, changed: changedModel };
}
