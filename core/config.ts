/**
 * config.ts
 * -----------------------------------------------------------------------------
 * The single source of truth for "everything is configurable". This is a plain
 * typed object you persist (DB) and edit in the UI; validate it with Zod at the
 * boundary. Pricing is a *list of scoped rules* resolved per variant, so new
 * pricing behaviour is data, never code.
 *
 * Plugs into core-spine.ts: resolveEffectiveRule() produces the rule that
 * computePrice()/buildPlan() consume.
 */

import type { DeliveryType, SourceProduct, SourceVariant } from "./core-spine";

/* ------------------------------------------------------------------ */
/* A. SOURCE / FETCH                                                   */
/* ------------------------------------------------------------------ */
export interface SourceConfig {
    market: string;                       // "IT"
    defaultDeliveryType: DeliveryType;    // which ask channel to read by default
    batchChunkSize: number;               // <= 50 (KicksDB hard cap)
    cacheTtlSeconds: number;              // how long a fetched price is "fresh"
    query: {                              // defaults for the products endpoint
        sort: string;                       // e.g. "release_date"
        limit: number;
        display: { traits: boolean; variants: boolean; identifiers: boolean; prices: boolean };
    };
}

/* ------------------------------------------------------------------ */
/* B. PRICING — scoped rules with precedence                          */
/* ------------------------------------------------------------------ */
export interface RuleScope {
    // any subset; omitted field = "matches anything". More fields set = more specific.
    brand?: string;
    model?: string;
    sku?: string;
    sizeType?: string;                    // "us m"
    sizeMin?: number;                     // numeric size range, inclusive
    sizeMax?: number;
}

export interface RoundingConfig {
    mode: "none" | "integer" | "charm" | "nearest";
    increment?: number;                   // charm -> .99/.95; nearest -> 5 / 10
}

export interface TaxConfig {
    priceIncludesVat: boolean;            // true => add VAT on top of the computed net
    vatRatePercent: number;               // e.g. 22 for IT
}

/**
 * One band of a dynamic (tiered) markup schedule. Bands are matched against the
 * SOURCE ASK (lowestAsk, in market currency) — i.e. our cost — so cheaper pairs
 * get a higher markup % without piling huge absolute markups onto expensive ones.
 * `upTo` is the exclusive upper bound of the band; `null` marks the open-ended
 * top band. Picked tier = the lowest `upTo` strictly greater than the ask.
 */
export interface MarkupTier {
    upTo: number | null;                  // exclusive upper bound on the ask; null = no cap (top band)
    markupPercent: number;
}

export interface ScopedPricingRule {
    id: string;
    scope: RuleScope;
    enabled: boolean;
    // pricing knobs (any may be omitted; the resolver fills from less-specific rules)
    sourceDeliveryType?: DeliveryType;
    markupPercent?: number;               // flat markup; ignored when markupTiers is set
    markupTiers?: MarkupTier[];           // dynamic markup by ask; overrides markupPercent when present
    floor?: number;
    minAsks?: number;                     // skip if liquidity below this
    rounding?: RoundingConfig;
    tax?: TaxConfig;
    maxDeltaPercent?: number;             // guardrail: reject change bigger than this
}

/* ------------------------------------------------------------------ */
/* C. MATCHING & APPLY                                                 */
/* ------------------------------------------------------------------ */
export interface MatchingConfig {
    // order in which we try to link a StockX variant to a Woo variation
    strategyOrder: ("upc" | "skuPattern" | "manual")[];
    // template for the SKU convention, e.g. "{sku}-{sizeType}-{size}"
    skuTemplate: string;
}

export interface ApplyConfig {
    includeActions: ("update" | "create")[]; // what Apply is allowed to do
    dryRunByDefault: boolean;
    requireApprovalAboveDeltaPercent: number; // hold changes bigger than this for review
    concurrency: number;                      // parallel parent-product batches
    wooBatchSize: number;                     // variations per batch call (<= ~100)
    retry: { attempts: number; backoffMs: number };
    schedule?: { cron: string } | null;       // null = manual only
}

/* ------------------------------------------------------------------ */
/* D. CONNECTION + ROOT CONFIG                                         */
/* ------------------------------------------------------------------ */
export interface ConnectionConfig {
    kicksDbApiKey: string;                // inject from env/secret store, not literals
    woo: { baseUrl: string; consumerKey: string; consumerSecret: string };
    marketToCurrency: Record<string, string>; // { IT: "EUR", US: "USD", ... }
}

export interface AppConfig {
    source: SourceConfig;
    pricingRules: ScopedPricingRule[];    // ordered general -> specific
    matching: MatchingConfig;
    apply: ApplyConfig;
    connection: ConnectionConfig;
}

/* ------------------------------------------------------------------ */
/* RESOLVER — merge all matching rules into one effective rule         */
/* ------------------------------------------------------------------ */
export interface EffectivePricingRule {
    sourceDeliveryType: DeliveryType;
    markupPercent: number;                // flat fallback; used when markupTiers is absent
    markupTiers?: MarkupTier[];           // dynamic markup by ask; takes precedence when present
    floor?: number;
    minAsks?: number;
    rounding: RoundingConfig;
    tax: TaxConfig;
    maxDeltaPercent?: number;
}

function sizeToNumber(size: string): number {
    const n = parseFloat(size);
    return Number.isNaN(n) ? NaN : n;
}

function scopeMatches(scope: RuleScope, p: SourceProduct, v: SourceVariant): boolean {
    if (scope.brand && scope.brand !== p.brand) return false;
    if (scope.sku && scope.sku !== p.sku) return false;
    if (scope.model && !p.title.includes(scope.model)) return false;
    if (scope.sizeType && scope.sizeType !== v.sizeType) return false;
    const sz = sizeToNumber(v.sizeLabel);
    if (scope.sizeMin != null && !(sz >= scope.sizeMin)) return false;
    if (scope.sizeMax != null && !(sz <= scope.sizeMax)) return false;
    return true;
}

/** Specificity = number of constrained fields; more specific rules win. */
function specificity(scope: RuleScope): number {
    return Object.values(scope).filter((x) => x != null).length;
}

/**
 * Returns the effective rule for one variant, or null if no rule applies.
 * Less-specific rules provide defaults; more-specific rules override field-by-field.
 */
export function resolveEffectiveRule(
    product: SourceProduct,
    variant: SourceVariant,
    config: AppConfig,
): EffectivePricingRule | null {
    const matched = config.pricingRules
        .filter((r) => r.enabled && scopeMatches(r.scope, product, variant))
        .sort((a, b) => specificity(a.scope) - specificity(b.scope)); // general first

    if (matched.length === 0) return null;

    const merged: Partial<EffectivePricingRule> = {
        sourceDeliveryType: config.source.defaultDeliveryType,
    };
    for (const r of matched) {
        if (r.sourceDeliveryType != null) merged.sourceDeliveryType = r.sourceDeliveryType;
        if (r.markupPercent != null) merged.markupPercent = r.markupPercent;
        // A non-empty tier schedule overrides; an explicit empty array clears it
        // (a more specific rule can switch a variant back to flat markup).
        if (r.markupTiers != null) merged.markupTiers = r.markupTiers.length ? r.markupTiers : undefined;
        if (r.floor != null) merged.floor = r.floor;
        if (r.minAsks != null) merged.minAsks = r.minAsks;
        if (r.rounding != null) merged.rounding = r.rounding;
        if (r.tax != null) merged.tax = r.tax;
        if (r.maxDeltaPercent != null) merged.maxDeltaPercent = r.maxDeltaPercent;
    }

    // Valid only if SOME markup was set — a flat percent or a tier schedule.
    if (merged.markupPercent == null && !merged.markupTiers?.length) return null;
    return {
        sourceDeliveryType: merged.sourceDeliveryType!,
        markupPercent: merged.markupPercent ?? 0,
        markupTiers: merged.markupTiers,
        floor: merged.floor,
        minAsks: merged.minAsks,
        rounding: merged.rounding ?? { mode: "none" },
        tax: merged.tax ?? { priceIncludesVat: false, vatRatePercent: 0 },
        maxDeltaPercent: merged.maxDeltaPercent,
    };
}