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
 * One step of a price-banded markup: applies to asks ≤ upTo (in the market's
 * major currency, BEFORE markup/VAT — i.e. the raw KicksDB lowest ask).
 * upTo null = no upper bound (the top band). Bands are ordered ascending.
 */
export interface MarkupBand {
    upTo: number | null;
    percent: number;
}

export interface ScopedPricingRule {
    id: string;
    scope: RuleScope;
    enabled: boolean;
    // pricing knobs (any may be omitted; the resolver fills from less-specific rules)
    sourceDeliveryType?: DeliveryType;
    markupPercent?: number;
    // Dynamic markup by ask price. When present it wins over markupPercent,
    // which remains the fallback for asks no band covers.
    markupBands?: MarkupBand[];
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
    markupPercent: number;               // fallback when no band covers the ask
    markupBands?: MarkupBand[];          // ordered ascending; wins when present
    floor?: number;
    minAsks?: number;
    rounding: RoundingConfig;
    tax: TaxConfig;
    maxDeltaPercent?: number;
}

/** Ascending by upTo, unbounded band last — resolution order for markupForAsk. */
export function sortMarkupBands(bands: MarkupBand[]): MarkupBand[] {
    return [...bands].sort((a, b) => {
        if (a.upTo == null) return 1;
        if (b.upTo == null) return -1;
        return a.upTo - b.upTo;
    });
}

/** The markup percent for a raw ask under a rule: first covering band, else the flat fallback. */
export function markupForAsk(ask: number, rule: EffectivePricingRule): number {
    for (const band of rule.markupBands ?? []) {
        if (band.upTo == null || ask <= band.upTo) return band.percent;
    }
    return rule.markupPercent;
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
        if (r.markupBands != null) merged.markupBands = sortMarkupBands(r.markupBands);
        if (r.floor != null) merged.floor = r.floor;
        if (r.minAsks != null) merged.minAsks = r.minAsks;
        if (r.rounding != null) merged.rounding = r.rounding;
        if (r.tax != null) merged.tax = r.tax;
        if (r.maxDeltaPercent != null) merged.maxDeltaPercent = r.maxDeltaPercent;
    }

    // A rule must set a markup somehow: flat, or banded (whose top band then
    // doubles as the flat fallback for anything the bands miss).
    if (merged.markupPercent == null) {
        const bands = merged.markupBands;
        if (!bands || bands.length === 0) return null;
        merged.markupPercent = bands[bands.length - 1].percent;
    }
    return {
        sourceDeliveryType: merged.sourceDeliveryType!,
        markupPercent: merged.markupPercent,
        markupBands: merged.markupBands,
        floor: merged.floor,
        minAsks: merged.minAsks,
        rounding: merged.rounding ?? { mode: "none" },
        tax: merged.tax ?? { priceIncludesVat: false, vatRatePercent: 0 },
        maxDeltaPercent: merged.maxDeltaPercent,
    };
}