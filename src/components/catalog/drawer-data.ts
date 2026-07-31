import "server-only";
import type { AppConfig } from "@core/config";
import { resolveEffectiveRule } from "@core/config";
import { computePrice } from "@core/core-spine";
import { getCatalogEntry } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import {
  followSaleRuleFor,
  lockedPricesFor,
  manualPriceFor,
  ownerPinFor,
} from "@/server/overrides/model";
import { gsOwnedProducts } from "@/server/feeds/owner";
import { getActiveSnapshot } from "@/server/store-json/repo";
import {
  hasActiveSale,
  managedStock,
  normSize,
  parsePrice,
  sourceEuSize,
  variationSizeLabel,
} from "@/server/store-json/match";
import { skuKey } from "@/lib/skus";

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

/** One size of a store-only product: live shelf price + managed stock. */
export interface StoreDrawerVariant {
  variationId: number;
  sizeLabel: string;
  price: number | null;
  saleActive: boolean;
  stock: number | null; // null = stock not managed on this variation
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
  /** Who owns this product: feed > store-only mirror > KicksDB. */
  owner: "kicksdb" | "goldensneakers" | "woo";
  /** An active GS feed listing covers this SKU → the price-source switch is shown. */
  gsCovered: boolean;
  /** The operator pinned this product back to StockX/KicksDB pricing. */
  pinnedToKicksdb: boolean;
  variants: DrawerVariant[];
  /** Store-only products: the live snapshot view, directly editable. */
  store: { productId: number; variants: StoreDrawerVariant[] } | null;
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
  // presented prices (passthrough rule) and real quantities. Coverage is
  // computed pin-blind so the drawer can offer the source switch either way.
  const covered = (await gsOwnedProducts([entry.sku], market, null)).get(entry.sku);
  const pin = overrides ? ownerPinFor(overrides, entry.sku) : null;
  const gs = pin === "kicksdb" ? undefined : covered;
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

  // Locks whose size the current variant set no longer offers (source switch,
  // feed takeover, dropped size) would otherwise be counted on the card but
  // invisible here — and silently re-applied if the size returns. Surface them
  // as rows so the operator can see and clear them.
  if (overrides) {
    const present = new Set(variants.map((v) => v.euSize).filter((s): s is string => s != null));
    for (const { euSize, price } of lockedPricesFor(overrides, entry.sku)) {
      if (present.has(euSize)) continue;
      variants.push({
        id: `orphan::${euSize}`,
        sizeLabel: euSize,
        sizeType: "EU",
        euSize,
        upc: null,
        ask: null,
        asks: 0,
        proposed: null,
        manual: price,
      });
    }
  }

  // Store-only products (source "woo", no feed linked): the drawer shows the
  // LIVE snapshot — shelf price + real stock per size — and edits write
  // straight to WooCommerce. No asks, no proposed prices, no locks.
  const storeOnly = entry.source === "woo" && gs == null;
  let store: DrawerData["store"] = null;
  if (storeOnly) {
    const snapshot = await getActiveSnapshot().catch(() => null);
    const prod = snapshot?.products.find((p) => skuKey(p.sku) === entry.sku);
    if (prod) {
      store = {
        productId: prod.id,
        variants: prod.variations
          .map<StoreDrawerVariant>((v) => ({
            variationId: v.id,
            sizeLabel: variationSizeLabel(prod.sku, v) ?? v.sku ?? String(v.id),
            price: parsePrice(v.regular_price),
            saleActive: hasActiveSale(v.sale_price),
            stock: managedStock(v),
          }))
          .sort((a, b) => {
            const an = Number.parseFloat(normSize(a.sizeLabel) ?? "");
            const bn = Number.parseFloat(normSize(b.sizeLabel) ?? "");
            return (Number.isFinite(an) ? an : 999) - (Number.isFinite(bn) ? bn : 999);
          }),
      };
    }
  }

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
      storeOnly ||
      new Date(entry.fetchedAt).getTime() >= Date.now() - config.source.cacheTtlSeconds * 1000,
    followSaleRule: overrides ? followSaleRuleFor(overrides, product.sku) : true,
    owner: gs ? "goldensneakers" : storeOnly ? "woo" : "kicksdb",
    gsCovered: covered != null,
    pinnedToKicksdb: pin === "kicksdb",
    variants,
    store,
  };
}
