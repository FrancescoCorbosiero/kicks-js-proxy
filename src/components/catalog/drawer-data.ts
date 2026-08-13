import "server-only";
import type { AppConfig, MarginKind, ScopedPricingRule } from "@core/config";
import { marginKindOf, resolveEffectiveRule, scopeSpecificity } from "@core/config";
import { computePrice, medianTierAsk } from "@core/core-spine";
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

/**
 * Which margin rule priced this product, in the terms the operator set it in.
 * The drawer is where "why is this price what it is?" gets asked, and until
 * the winning rule was named there was no way to tell a family rule that is
 * working from one a broader rule silently outranks.
 */
export interface AppliedRule {
  id: string;
  /** The rule's scope, rendered: "Yeezy › Foam RNNR", "Jordan", "CT8012-047". */
  scopeLabel: string;
  kind: MarginKind;
  markupPercent: number | null;
  markupFixed: number | null;
  bands: { upTo: number | null; percent: number }[] | null;
  /** The general catch-all rule — i.e. this product has no rule of its own. */
  isGeneral: boolean;
  /** Sizes of this product are priced by different rules (a size-scoped rule). */
  mixed: boolean;
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
  /** The margin rule the proposed prices come from; null when nothing prices it. */
  appliedRule: AppliedRule | null;
  /** Store-only products: the live snapshot view, directly editable. */
  store: { productId: number; variants: StoreDrawerVariant[] } | null;
}

/** Render a rule's scope the way the margins editor labels it. */
function scopeLabelOf(rule: ScopedPricingRule): string {
  const s = rule.scope;
  const bits = [
    s.brand,
    [s.category, s.secondaryCategory].filter(Boolean).join(" › ") || null,
    s.model ? `“${s.model}”` : null,
    s.sku,
    s.sizeMin != null || s.sizeMax != null ? `${s.sizeMin ?? ""}–${s.sizeMax ?? ""}` : null,
    s.source,
  ].filter(Boolean);
  return bits.join(" · ");
}

function describeRule(
  rule: ScopedPricingRule,
  mixed: boolean,
): AppliedRule {
  return {
    id: rule.id,
    scopeLabel: scopeLabelOf(rule),
    kind: marginKindOf(rule),
    markupPercent: rule.markupPercent ?? null,
    markupFixed: rule.markupFixed ?? null,
    bands: rule.markupBands && rule.markupBands.length > 0 ? rule.markupBands : null,
    isGeneral: Object.keys(rule.scope).length === 0,
    mixed,
  };
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

  // Which rule owns the margin, collected as the variants are priced: sizes
  // can legitimately fall under different rules (a size-scoped rule), so the
  // drawer reports one rule only when they all agree.
  const markupRuleIds = new Set<string>();

  const variants = product.variants.map<DrawerVariant>((v) => {
    const euSize = sourceEuSize(v) ?? null;
    const offer = v.offers.find((o) => o.deliveryType === deliveryType) ?? v.offers[0] ?? null;
    const rule = resolveEffectiveRule(product, v, config);
    if (rule?.markupRuleId) markupRuleIds.add(rule.markupRuleId);
    return {
      id: v.stockxVariantId,
      sizeLabel: v.sizeLabel,
      sizeType: v.sizeType,
      euSize,
      upc: v.upc ?? null,
      ask: offer && offer.lowestAsk > 0 ? offer.lowestAsk : null,
      asks: offer?.asks ?? 0,
      proposed: rule
        ? computePrice(v, rule, { medianAsk: medianTierAsk(product, rule.sourceDeliveryType) })
        : null,
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
    appliedRule: (() => {
      // With several rules in play, name the most specific one — that is the
      // deliberate instruction the operator wants to verify — and flag the mix.
      const winners = config.pricingRules.filter((r) => markupRuleIds.has(r.id));
      if (winners.length === 0) return null;
      const most = winners.reduce((a, b) =>
        scopeSpecificity(b.scope) >= scopeSpecificity(a.scope) ? b : a,
      );
      return describeRule(most, winners.length > 1);
    })(),
    store,
  };
}
