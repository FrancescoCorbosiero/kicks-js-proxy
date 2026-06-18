/**
 * engine.ts — the bridge between the dashboard and the real domain core.
 *
 * - `mapKicksProduct` + `resolveEffectiveRule` are the genuine functions from
 *   core-spine.ts / config.ts. Nothing here re-implements rule resolution.
 * - `priceVariant` follows the documented EffectivePricingRule semantics
 *   (markup → floor → tax → rounding), which extend the core's simplified
 *   `computePrice`. We keep the same Plan / PlanItem shapes the core defines.
 */

import {
  mapKicksProduct,
  type Plan,
  type PlanItem,
  type SourceProduct,
  type SourceVariant,
} from "@/core/core-spine";
import {
  resolveEffectiveRule,
  type AppConfig,
  type EffectivePricingRule,
} from "@/config";
import { RAW_PRODUCTS, STORE_PRICES } from "@/lib/sample";

export function loadProducts(market = "IT"): SourceProduct[] {
  return RAW_PRODUCTS.map((raw) => mapKicksProduct(raw, market));
}

/** Apply an effective rule to a variant. Returns null when the rule says skip. */
export function priceVariant(
  variant: SourceVariant,
  rule: EffectivePricingRule,
): { price: number | null; reason?: string } {
  const offer = variant.offers.find((o) => o.deliveryType === rule.sourceDeliveryType);
  if (!offer) return { price: null, reason: "no offer for delivery type" };
  if (rule.minAsks != null && offer.asks < rule.minAsks) {
    return { price: null, reason: `liquidity ${offer.asks} < minAsks ${rule.minAsks}` };
  }

  let price = offer.lowestAsk * (1 + rule.markupPercent / 100);
  if (rule.floor != null) price = Math.max(price, rule.floor);
  if (rule.tax.priceIncludesVat) price *= 1 + rule.tax.vatRatePercent / 100;

  switch (rule.rounding.mode) {
    case "integer":
      price = Math.round(price);
      break;
    case "charm": {
      const inc = rule.rounding.increment ?? 0.99;
      price = Math.floor(price) + inc;
      break;
    }
    case "nearest": {
      const inc = rule.rounding.increment ?? 5;
      price = Math.round(price / inc) * inc;
      break;
    }
    default:
      price = Math.round(price * 100) / 100;
  }
  return { price: Math.round(price * 100) / 100 };
}

export interface PlanItemX extends PlanItem {
  brand: string;
  title: string;
  image: string;
  ruleId: string | null;
  deltaPercent: number | null;
  held: boolean; // exceeds requireApprovalAboveDeltaPercent
}

export interface PlanX extends Plan {
  stockxId: string;
  title: string;
  brand: string;
  image: string;
  items: PlanItemX[];
}

export function buildPlanFor(product: SourceProduct, config: AppConfig): PlanX {
  const holdAt = config.apply.requireApprovalAboveDeltaPercent;
  const items = product.variants.map<PlanItemX>((v) => {
    const rule = resolveEffectiveRule(product, v, config);
    const current = STORE_PRICES[v.stockxVariantId] ?? null;
    const base: Omit<PlanItemX, "action" | "proposedPrice" | "deltaPercent" | "held" | "reason"> = {
      stockxVariantId: v.stockxVariantId,
      sizeLabel: v.sizeLabel,
      upc: v.upc,
      storeProductId: current != null ? hashId(product.stockxId) : null,
      storeVariationId: current != null ? hashId(v.stockxVariantId) : null,
      currentPrice: current,
      brand: product.brand,
      title: product.title,
      image: product.image,
      ruleId: rule ? ruleIdFor(product, v, config) : null,
    };

    if (!rule) {
      return { ...base, proposedPrice: null, action: "skip", reason: "no matching rule", deltaPercent: null, held: false };
    }
    const { price, reason } = priceVariant(v, rule);
    if (price == null) {
      return { ...base, proposedPrice: null, action: "skip", reason, deltaPercent: null, held: false };
    }
    if (current == null) {
      return { ...base, proposedPrice: price, action: "create", deltaPercent: null, held: false };
    }
    const d = current === 0 ? null : ((price - current) / current) * 100;
    const action = Math.abs(price - current) < 0.005 ? "noop" : "update";
    const held = d != null && Math.abs(d) > holdAt && action === "update";
    return { ...base, proposedPrice: price, action, deltaPercent: d, held };
  });

  return {
    stockxId: product.stockxId,
    sku: product.sku,
    currency: product.currency,
    title: product.title,
    brand: product.brand,
    image: product.image,
    generatedAt: new Date().toISOString(),
    items,
  };
}

export function buildAllPlans(config: AppConfig): PlanX[] {
  return loadProducts(config.source.market).map((p) => buildPlanFor(p, config));
}

/* ---- aggregate stats for the overview ---------------------------------- */
export interface PlanStats {
  products: number;
  variants: number;
  update: number;
  create: number;
  noop: number;
  skip: number;
  held: number;
  avgDelta: number | null;
  exposure: number; // sum of proposed price across actionable items
}

export function statsFor(plans: PlanX[]): PlanStats {
  let variants = 0, update = 0, create = 0, noop = 0, skip = 0, held = 0, exposure = 0;
  const deltas: number[] = [];
  for (const p of plans) {
    for (const it of p.items) {
      variants++;
      if (it.action === "update") update++;
      if (it.action === "create") create++;
      if (it.action === "noop") noop++;
      if (it.action === "skip") skip++;
      if (it.held) held++;
      if (it.proposedPrice != null && (it.action === "update" || it.action === "create")) {
        exposure += it.proposedPrice;
      }
      if (it.deltaPercent != null) deltas.push(it.deltaPercent);
    }
  }
  const avgDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  return { products: plans.length, variants, update, create, noop, skip, held, avgDelta, exposure };
}

/* Which concrete rule id wins for a variant (for display/explainability). */
function ruleIdFor(product: SourceProduct, variant: SourceVariant, config: AppConfig): string | null {
  const matched = config.pricingRules
    .filter((r) => r.enabled)
    .filter((r) => scopeMatchesLite(r.scope, product, variant))
    .sort((a, b) => specificity(a.scope) - specificity(b.scope));
  return matched.length ? matched[matched.length - 1].id : null;
}

function scopeMatchesLite(scope: AppConfig["pricingRules"][number]["scope"], p: SourceProduct, v: SourceVariant): boolean {
  if (scope.brand && scope.brand !== p.brand) return false;
  if (scope.sku && scope.sku !== p.sku) return false;
  if (scope.model && !p.title.includes(scope.model)) return false;
  if (scope.sizeType && scope.sizeType !== v.sizeType) return false;
  const sz = parseFloat(v.sizeLabel);
  if (scope.sizeMin != null && !(sz >= scope.sizeMin)) return false;
  if (scope.sizeMax != null && !(sz <= scope.sizeMax)) return false;
  return true;
}
function specificity(scope: object): number {
  return Object.values(scope).filter((x) => x != null).length;
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 90000 + 10000;
}
