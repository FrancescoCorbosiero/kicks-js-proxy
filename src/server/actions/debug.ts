"use server";

import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { resolveFromModel, sourceEuSize, variationEuSize } from "@/server/store-json/match";
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
      pa_taglia: v.attributes?.["attribute_pa_taglia"],
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
