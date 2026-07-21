import "server-only";
import type { AppConfig } from "@core/config";
import { resolveEffectiveRule } from "@core/config";
import { computePrice } from "@core/core-spine";
import { getCatalogEntry } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { followSaleRuleFor, manualPriceFor } from "@/server/overrides/model";
import { gsOwnedProducts } from "@/server/feeds/owner";
import { sourceEuSize } from "@/server/store-json/match";

/** One drawer row: a size variant with its ask, computed price and override state. */
export interface DrawerVariant {
  id: string; // stockxVariantId
  sizeLabel: string;
  sizeType: string;
  euSize: string | null;
  upc: string | null;
  ask: number | null; // lowest ask for the configured delivery type
  asks: number; // liquidity depth at that ask
  proposed: number | null; // computePrice under the current pricing rules
  manual: number | null; // operator-locked price (overrides subsystem)
}

export interface DrawerData {
  market: string;
  sku: string;
  title: string;
  brand: string;
  image: string;
  stockxId: string;
  currency: string;
  addedAt: string;
  fetchedAt: string;
  fresh: boolean;
  followSaleRule: boolean;
  /** Who owns this product: the feed's variant set replaces KicksDB's when GS. */
  owner: "kicksdb" | "goldensneakers";
  variants: DrawerVariant[];
}

/**
 * Assemble everything the product drawer shows: the catalog entry, the
 * computed proposed price per variant under the live pricing rules, and the
 * operator override state (manual locks + sale rule) keyed by SKU/EU size.
 */
export async function loadDrawerData(
  market: string,
  sku: string,
  config: AppConfig,
): Promise<DrawerData | null> {
  const entry = await getCatalogEntry(market, sku);
  if (!entry) return null;

  const overrides = await getOverrides().catch(() => null);
  // Product-level ownership: a GS-owned product shows the FEED's sizes,
  // presented prices (passthrough rule) and real quantities.
  const gs = (await gsOwnedProducts([entry.sku], market, overrides)).get(entry.sku);
  const product = gs?.product ?? entry.product;
  const deliveryType = config.source.defaultDeliveryType;

  const variants = product.variants.map<DrawerVariant>((v) => {
    const euSize = sourceEuSize(v) ?? null;
    const offer = v.offers.find((o) => o.deliveryType === deliveryType) ?? v.offers[0] ?? null;
    const rule = resolveEffectiveRule(product, v, config);
    return {
      id: v.stockxVariantId,
      sizeLabel: v.sizeLabel,
      sizeType: v.sizeType,
      euSize,
      upc: v.upc ?? null,
      ask: offer && offer.lowestAsk > 0 ? offer.lowestAsk : null,
      asks: offer?.asks ?? 0,
      proposed: rule ? computePrice(v, rule) : null,
      manual: overrides && euSize ? manualPriceFor(overrides, product.sku, euSize) : null,
    };
  });

  return {
    market,
    sku: entry.sku,
    title: entry.title || product.title,
    brand: entry.brand || product.brand,
    image: entry.image || product.image,
    stockxId: product.stockxId,
    currency: product.currency,
    addedAt: entry.addedAt,
    fetchedAt: entry.fetchedAt,
    fresh:
      gs != null ||
      new Date(entry.fetchedAt).getTime() >= Date.now() - config.source.cacheTtlSeconds * 1000,
    followSaleRule: overrides ? followSaleRuleFor(overrides, product.sku) : true,
    owner: gs ? "goldensneakers" : "kicksdb",
    variants,
  };
}
