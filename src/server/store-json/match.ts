import type { SourceProduct, SourceVariant, VariantMapping } from "@core/core-spine";
import { euSize } from "@/lib/sizes";
import { skuKey } from "@/lib/skus";
import type { StoreModel, StoreVariation } from "./model";

/** Canonical numeric size key: "35-5" -> "35.5", "42.5" -> "42.5", "44" -> "44". */
export function normSize(s: string | null | undefined): string | null {
  if (s == null) return null;
  const n = Number.parseFloat(String(s).trim().replace(",", ".").replace("-", "."));
  return Number.isNaN(n) ? null : String(n);
}

function parsePrice(s?: string | null): number | null {
  if (s == null || s === "") return null;
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** EU size of a StockX variant: from the size conversions, or the label if the
 *  variant's own system is already EU. */
export function sourceEuSize(v: SourceVariant): string | null {
  const eu = euSize(v.sizes);
  if (eu) return normSize(eu);
  if (/eu/i.test(v.sizeType)) return normSize(v.sizeLabel);
  return null;
}

/** EU size of a store variation: from the "{sku}-{size}" suffix, else the
 *  pa_taglia attribute. */
export function variationEuSize(parentSku: string, vrt: StoreVariation): string | null {
  if (vrt.sku && vrt.sku.toUpperCase().startsWith(`${parentSku.toUpperCase()}-`)) {
    return normSize(vrt.sku.slice(parentSku.length + 1));
  }
  const ta = vrt.attributes?.["attribute_pa_taglia"];
  if (ta != null) return normSize(String(ta));
  return null;
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

  const bySize = new Map<string, StoreVariation>();
  for (const vrt of prod.variations) {
    const e = variationEuSize(prod.sku, vrt);
    if (e && !bySize.has(e)) bySize.set(e, vrt);
  }

  for (const v of product.variants) {
    const e = sourceEuSize(v);
    if (!e) continue;
    const vrt = bySize.get(e);
    if (!vrt) continue;
    map.set(v.stockxVariantId, {
      stockxVariantId: v.stockxVariantId,
      storeProductId: prod.id,
      storeVariationId: vrt.id,
      currentPrice: parsePrice(vrt.regular_price),
    });
  }
  return map;
}
