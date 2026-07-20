import type { SourceProduct } from "@core/core-spine";
import { computePrice } from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { resolveEffectiveRule } from "@core/config";
import { euSize } from "@/lib/sizes";
import { skuKey } from "@/lib/skus";
import { humanEuSize, normSize, preferStoreVariation, variationEuSize } from "./match";
import type { StoreVariation } from "./model";

/**
 * The Rebuild planner: obliterate a product's variation set and re-create it
 * from the KicksDB catalog — without touching the parent (where SEO, media,
 * taxonomies and swatches live) and without losing per-variation extras.
 *
 * Carry-over is KEY-AGNOSTIC, mirroring the round-trip philosophy: for every
 * canonical size that also existed before, the old variation's ENTIRE payload
 * is copied into the create body except the fields we intentionally
 * regenerate (identity, size attribute, price, stock, server-derived fields).
 * meta_data, image, description, sale windows and any plugin field we have
 * never heard of ride along untouched.
 *
 * Pure: no HTTP, no DB — fully unit-testable. The executor (server/woo)
 * feeds it fresh REST payloads and runs the writes.
 */

/** Fields the rebuild regenerates or that Woo derives — never carried over. */
const REGENERATED_FIELDS = new Set([
  "id",
  "sku",
  "attributes",
  "regular_price",
  "price",
  "on_sale",
  "stock_quantity",
  "stock_status",
  "manage_stock",
  "backorders_allowed", // derived
  "date_created",
  "date_created_gmt",
  "date_modified",
  "date_modified_gmt",
  "permalink",
  "parent_id",
  "_links",
]);

export type RebuildPriceSource = "manual" | "computed" | "carried" | "none";

export interface RebuildVariationPlan {
  sizeLabel: string; // human label, e.g. "36 2/3"
  euNorm: string; // canonical numeric key, e.g. "36.67"
  sku: string;
  price: number | null;
  priceSource: RebuildPriceSource;
  upc: string | null;
  carriedFrom: number | null; // old variation id whose extras were copied
  payload: Record<string, unknown>; // the REST create body
}

export interface RebuildPlan {
  sku: string;
  storeProductId: number;
  /** Every existing variation — the set is rebuilt from scratch. */
  deleteVariationIds: number[];
  create: RebuildVariationPlan[];
  /** Canonical pa_taglia option list for the parent, sorted ascending. */
  parentSizeOptions: string[];
  /** Old sizes with no catalog twin: their variations (and extras) disappear. */
  droppedOldSizes: string[];
  /** Created without any price (no ask, no manual lock, no old price). */
  unpricedSizes: string[];
  /** Catalog variants skipped because no EU size could be resolved. */
  skippedNoEu: number;
  carriedCount: number;
}

function parsePrice(s: unknown): number | null {
  if (typeof s !== "string" || s === "") return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Numeric sort of human size labels via normSize ("36" < "36 2/3" < "42.5"). */
function sortLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const na = Number.parseFloat(normSize(a) ?? "");
    const nb = Number.parseFloat(normSize(b) ?? "");
    if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
    return na - nb;
  });
}

/** Group old variations by canonical size, keeping the best twin per size. */
function bestOldBySize(parentSku: string, old: StoreVariation[]): Map<string, StoreVariation> {
  const groups = new Map<string, StoreVariation[]>();
  for (const vrt of old) {
    const key = variationEuSize(parentSku, vrt);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(vrt);
    else groups.set(key, [vrt]);
  }
  const best = new Map<string, StoreVariation>();
  for (const [key, list] of groups) {
    best.set(
      key,
      list.reduce((a, b) => (preferStoreVariation(parentSku, a, b) <= 0 ? a : b)),
    );
  }
  return best;
}

export function planRebuild(input: {
  parentSku: string;
  storeProductId: number;
  catalog: SourceProduct;
  oldVariations: StoreVariation[];
  config: AppConfig;
  /** Operator price locks keyed by canonical EU size (euNorm). */
  manualPrices?: Record<string, number>;
  /** Global pa_taglia attribute id, when known — makes create bindings exact. */
  tagliaAttributeId?: number;
  /**
   * Real per-size stock (euNorm → quantity), for feed-owned products.
   * Present: managed stock with the real count (0 → outofstock, kept).
   * Absent: KicksDB sell-on-demand (instock, unmanaged).
   */
  stockBySize?: Record<string, number>;
}): RebuildPlan {
  const { parentSku, storeProductId, catalog, oldVariations, config } = input;
  const manual = input.manualPrices ?? {};
  const oldBySize = bestOldBySize(parentSku, oldVariations);

  const create: RebuildVariationPlan[] = [];
  const seen = new Set<string>();
  let skippedNoEu = 0;
  let carriedCount = 0;

  for (const variant of catalog.variants) {
    const rawEu = euSize(variant.sizes) ?? (/eu/i.test(variant.sizeType) ? variant.sizeLabel : null);
    const euNorm = rawEu != null ? normSize(rawEu) : null;
    const label = rawEu != null ? humanEuSize(rawEu) : null;
    if (!euNorm || !label || seen.has(euNorm)) {
      if (!euNorm || !label) skippedNoEu += 1;
      continue;
    }
    seen.add(euNorm);

    const old = oldBySize.get(euNorm) ?? null;

    // Price: operator lock > pricing engine > the old shelf price > none.
    const rule = resolveEffectiveRule(catalog, variant, config);
    const computed = rule ? computePrice(variant, rule) : null;
    let price: number | null;
    let priceSource: RebuildPriceSource;
    if (manual[euNorm] != null) {
      price = manual[euNorm];
      priceSource = "manual";
    } else if (computed != null) {
      price = computed;
      priceSource = "computed";
    } else if (old && parsePrice(old.regular_price) != null) {
      price = parsePrice(old.regular_price);
      priceSource = "carried";
    } else {
      price = null;
      priceSource = "none";
    }

    // Key-agnostic carry-over: everything except the regenerated fields.
    const payload: Record<string, unknown> = {};
    if (old) {
      for (const [k, v] of Object.entries(old)) {
        if (!REGENERATED_FIELDS.has(k)) payload[k] = v;
      }
      carriedCount += 1;
    }

    const upc = variant.upc ?? null;
    payload.sku = `${skuKey(parentSku)}-EU${label}`;
    payload.attributes = [
      input.tagliaAttributeId != null
        ? { id: input.tagliaAttributeId, option: label }
        : { name: "pa_taglia", option: label },
    ];
    if (price != null) payload.regular_price = price.toFixed(2);
    const realStock = input.stockBySize?.[euNorm];
    if (realStock != null) {
      // Feed-owned: the supplier reports true availability.
      payload.manage_stock = true;
      payload.stock_quantity = realStock;
      payload.stock_status = realStock > 0 ? "instock" : "outofstock";
    } else {
      // Sell on demand: available without a fake count (KicksDB carries no stock).
      payload.stock_status = "instock";
      payload.manage_stock = false;
    }
    if (upc) payload.global_unique_id = upc; // else a carried GTIN survives

    create.push({
      sizeLabel: label,
      euNorm,
      sku: payload.sku as string,
      price,
      priceSource,
      upc,
      carriedFrom: old ? old.id : null,
      payload,
    });
  }

  create.sort((a, b) => Number.parseFloat(a.euNorm) - Number.parseFloat(b.euNorm));

  const droppedOldSizes = sortLabels(
    [...oldBySize.keys()]
      .filter((k) => !seen.has(k))
      .map((k) => humanEuSize(k) ?? k),
  );

  return {
    sku: parentSku,
    storeProductId,
    deleteVariationIds: oldVariations.map((v) => v.id),
    create,
    parentSizeOptions: sortLabels(create.map((c) => c.sizeLabel)),
    droppedOldSizes,
    unpricedSizes: create.filter((c) => c.price == null).map((c) => c.sizeLabel),
    skippedNoEu,
    carriedCount,
  };
}

/**
 * Rebuild the parent's attribute list: preserve every non-taglia entry as-is
 * and replace (or append — the broken products carry an empty stub, or nothing
 * at all) the pa_taglia entry with the canonical option list. Returns the full
 * attributes array for the parent PUT.
 */
export function rebuildParentAttributes(
  currentAttributes: unknown,
  sizeOptions: string[],
  tagliaAttributeId?: number,
): Record<string, unknown>[] {
  const isTaglia = (o: Record<string, unknown>) =>
    String(o.name ?? o.slug ?? "").toLowerCase().includes("taglia");

  const tagliaEntry: Record<string, unknown> = {
    ...(tagliaAttributeId != null ? { id: tagliaAttributeId } : {}),
    name: "pa_taglia",
    variation: true,
    visible: true,
    options: sizeOptions,
  };

  const out: Record<string, unknown>[] = [];
  let replaced = false;
  if (Array.isArray(currentAttributes)) {
    for (const el of currentAttributes) {
      if (el && typeof el === "object" && isTaglia(el as Record<string, unknown>)) {
        const existing = el as Record<string, unknown>;
        out.push({
          ...existing,
          ...(existing.id == null && tagliaAttributeId != null ? { id: tagliaAttributeId } : {}),
          variation: true,
          visible: true,
          options: sizeOptions,
        });
        replaced = true;
      } else if (el && typeof el === "object") {
        out.push(el as Record<string, unknown>);
      }
    }
  }
  if (!replaced) out.push(tagliaEntry);
  return out;
}
