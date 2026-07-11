import type { SourceProduct, SourceVariant, VariantMapping } from "@core/core-spine";
import { euSize } from "@/lib/sizes";
import { skuKey } from "@/lib/skus";
import type { StoreModel, StoreVariation } from "./model";

/**
 * Canonical numeric size key, tolerant of prefixes, dash-decimals and mixed
 * fractions: "EU 38.5" -> "38.5", "US M 6" -> "6", "40-5" -> "40.5",
 * "EU 36 2/3" -> "36.67".
 */
export function normSize(s: string | null | undefined): string | null {
  if (s == null) return null;
  const str = String(s);
  const frac = str.match(/(\d+)\s+(\d+)\/(\d+)/); // mixed fraction "36 2/3"
  if (frac) {
    const v = Number(frac[1]) + Number(frac[2]) / Number(frac[3]);
    return String(Math.round(v * 100) / 100);
  }
  // Corrupt-snapshot mixed fraction: pa_taglia "36-2-3" == "36 2/3", "35-1-3" ==
  // "35 1/3" (whole-numerator-denominator, dash-separated). Handled before the
  // generic branch below, which would otherwise read "36-2-3" as "36.2".
  const dashFrac = str.match(/^\s*(\d+)-(\d+)-(\d+)\s*$/);
  if (dashFrac) {
    const v = Number(dashFrac[1]) + Number(dashFrac[2]) / Number(dashFrac[3]);
    return String(Math.round(v * 100) / 100);
  }
  const m = str.match(/\d+(?:[.,-]\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0].replace(",", ".").replace("-", "."));
  return Number.isNaN(n) ? null : String(n);
}

// Real EU shoe sizes sit in this range. Anything outside is a corrupt encoding —
// the snapshot SKU suffix "3623" (for size 36 2/3) normalizes to a bare 3623.
const EU_MIN = 10;
const EU_MAX = 75;

/** The size string back if it is a plausible EU shoe size, else null. */
function plausibleEu(size: string | null): string | null {
  if (size == null) return null;
  const n = Number.parseFloat(size);
  return Number.isFinite(n) && n >= EU_MIN && n <= EU_MAX ? size : null;
}

function parsePrice(s?: string | null): number | null {
  if (s == null || s === "") return null;
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** A variation is on a manual discount when it has a positive sale_price. */
function hasActiveSale(s?: string | null): boolean {
  const n = parsePrice(s);
  return n != null && n > 0;
}

/** EU size of a StockX variant: from the size conversions, or the label if the
 *  variant's own system is already EU. */
export function sourceEuSize(v: SourceVariant): string | null {
  const eu = euSize(v.sizes);
  if (eu) return normSize(eu);
  if (/eu/i.test(v.sizeType)) return normSize(v.sizeLabel);
  return null;
}

/** The "{sku}-{size}" suffix of a store variation, or null when the SKU does not
 *  follow the parent-prefixed convention. */
function skuSuffix(parentSku: string, vrt: StoreVariation): string | null {
  if (vrt.sku && vrt.sku.toUpperCase().startsWith(`${parentSku.toUpperCase()}-`)) {
    return vrt.sku.slice(parentSku.length + 1);
  }
  return null;
}

/**
 * Canonical numeric EU-size key of a store variation, used for matching + dedup.
 * The SKU suffix wins when it yields a *plausible* size ("IE7002-EU36 2/3" -> 36.67);
 * the corrupt snapshot SKUs encode "36 2/3" as "3623" (-> 3623), so an implausible
 * value is rejected and we fall back to pa_taglia ("36-2-3" -> 36.67).
 */
export function variationEuSize(parentSku: string, vrt: StoreVariation): string | null {
  const suffix = skuSuffix(parentSku, vrt);
  const fromSku = suffix != null ? normSize(suffix) : null;
  if (plausibleEu(fromSku)) return fromSku;
  const ta = vrt.attributes?.["attribute_pa_taglia"];
  if (ta != null) {
    const fromTa = normSize(String(ta));
    if (fromTa != null) return fromTa;
  }
  return fromSku; // implausible SKU with no usable pa_taglia — best effort
}

/**
 * The store's human-readable EU size label for a raw size string, or null if it
 * isn't a size we recognize. Collapses every encoding we've seen to one shape:
 * "36 2/3" and the corrupt "36-2-3" -> "36 2/3"; "42.5"/"42-5"/"42,5" -> "42.5";
 * "36"/"EU 36" -> "36". This is the value pa_taglia should carry (not the numeric
 * key "36.67"), so the size the customer sees matches the web-app data entry.
 */
export function humanEuSize(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^eu\s*/i, "");
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); // "36 2/3"
  if (m) return `${m[1]} ${m[2]}/${m[3]}`;
  m = s.match(/^(\d+)-(\d+)-(\d+)$/); // corrupt "36-2-3"
  if (m) return `${m[1]} ${m[2]}/${m[3]}`;
  m = s.match(/^(\d+)[.,-](\d+)$/); // half "42.5" / "42,5" / "42-5"
  if (m) return `${m[1]}.${m[2]}`;
  if (/^\d+$/.test(s)) return s; // whole "36"
  return null;
}

/** The human EU size label for a store variation: pa_taglia (the store's own
 *  label) first, then the SKU suffix. Null when neither is a recognizable size. */
export function variationSizeLabel(parentSku: string, vrt: StoreVariation): string | null {
  const ta = vrt.attributes?.["attribute_pa_taglia"];
  const fromTa = humanEuSize(ta == null ? null : String(ta));
  if (fromTa) return fromTa;
  const suffix = skuSuffix(parentSku, vrt);
  return suffix != null ? humanEuSize(suffix) : null;
}

/** True when the variation's SKU suffix parses straight to a plausible EU size —
 *  the "clean" web-app encoding ("IE7002-EU36 2/3"), as opposed to the corrupt
 *  snapshot one ("IE7002-3623", which normalizes to an absurd 3623). */
export function hasCleanSkuSize(parentSku: string, vrt: StoreVariation): boolean {
  const suffix = skuSuffix(parentSku, vrt);
  return suffix != null && plausibleEu(normSize(suffix)) != null;
}

/**
 * Order two store variations for the SAME physical size, best first (negative =>
 * `a` wins). Prefer the clean (web-app) SKU encoding over the corrupt snapshot
 * one, then the most recently created row (higher Woo id = the later data entry)
 * over the older snapshot import.
 */
export function preferStoreVariation(
  parentSku: string,
  a: StoreVariation,
  b: StoreVariation,
): number {
  const clean = (hasCleanSkuSize(parentSku, b) ? 1 : 0) - (hasCleanSkuSize(parentSku, a) ? 1 : 0);
  if (clean !== 0) return clean; // clean first
  return b.id - a.id; // newer (higher id) first
}

/**
 * Resolve StockX variants -> store variations for one product, matched by EU
 * size. Returns the same Map shape buildPlan expects (storeProductId/Variation +
 * current price). Variants with no match are absent -> treated as "create".
 */
export function resolveFromModel(
  model: StoreModel,
  product: SourceProduct,
): Map<string, VariantMapping> {
  const map = new Map<string, VariantMapping>();
  const prod = model.products.find((p) => skuKey(p.sku) === skuKey(product.sku));
  if (!prod) return map;

  // Index variations by GTIN (global_unique_id) and by EU size. When the corrupt
  // snapshot carries two variations for one size, keep the best (clean/newer) one
  // so KicksDB links to it — the losing twin is dropped by sanitize's dedup.
  const byGtin = new Map<string, StoreVariation>();
  const bySize = new Map<string, StoreVariation>();
  for (const vrt of prod.variations) {
    if (vrt.global_unique_id) byGtin.set(vrt.global_unique_id, vrt);
    const e = variationEuSize(prod.sku, vrt);
    if (!e) continue;
    const cur = bySize.get(e);
    if (!cur || preferStoreVariation(prod.sku, vrt, cur) < 0) bySize.set(e, vrt);
  }

  for (const v of product.variants) {
    // Prefer GTIN when both sides have it (robust across size-label drift);
    // otherwise fall back to EU size.
    let vrt = v.upc ? byGtin.get(v.upc) : undefined;
    if (!vrt) {
      const e = sourceEuSize(v);
      if (e) vrt = bySize.get(e);
    }
    if (!vrt) continue;
    map.set(v.stockxVariantId, {
      stockxVariantId: v.stockxVariantId,
      storeProductId: prod.id,
      storeVariationId: vrt.id,
      currentPrice: parsePrice(vrt.regular_price),
      saleActive: hasActiveSale(vrt.sale_price),
    });
  }
  return map;
}
