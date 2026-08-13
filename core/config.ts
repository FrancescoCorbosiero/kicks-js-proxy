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
    // any subset; omitted field = "matches anything". Narrower fields weigh
    // more (see SCOPE_WEIGHT) — a per-SKU rule always beats a family rule.
    // Every text field matches case-insensitively and trimmed.
    source?: string;                      // "kicksdb" (default) | a feed name, e.g. "goldensneakers"
    brand?: string;
    /**
     * The catalog's own navigation axes — the same two the store browses by
     * (`/marchio/yeezy/yeezy-foam/` is category "Yeezy", secondary "Foam
     * RNNR"). This is how a product FAMILY gets its own markup: the operator
     * picks the family off the catalog tree instead of guessing a title
     * substring. Exact match, case-insensitive.
     */
    category?: string;
    secondaryCategory?: string;
    /** Substring of the product's model or title (case-insensitive). */
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
    // Fixed margin in currency units (ask + N€) — the scs-b2b style "Jordan
    // +3€ fissi". A rule setting it becomes a fixed-margin rule: bands and
    // percent from less-specific rules stop applying.
    markupFixed?: number;
    /**
     * Never sell below ask + this amount (currency units). Percent markups
     * under-cover cheap asks — sourcing costs have a FIXED part (shipping,
     * marketplace fees) that 35% of a 44€ ask doesn't reach. The cheap market
     * occasion stays listed, but the margin is guaranteed. 0/absent = off.
     */
    minMarginFixed?: number;
    floor?: number;
    minAsks?: number;                     // skip if liquidity below this
    rounding?: RoundingConfig;
    tax?: TaxConfig;
    maxDeltaPercent?: number;             // guardrail: reject change bigger than this
    minDeltaPercent?: number;             // skip writes smaller than this (anti-churn)
    /**
     * Distribution guard: a variant whose ask falls below this percent of the
     * PRODUCT's median ask is treated as unreliable data (a bad API row, a
     * glitched listing) and priced as if it were AT that floor — one size can
     * never undercut its own product wildly. 0 or absent = off.
     */
    outlierFloorPercent?: number;
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
    markupFixed?: number;                // fixed € margin — wins over percent/bands
    minMarginFixed?: number;             // price never below ask + this (€)
    floor?: number;
    minAsks?: number;
    rounding: RoundingConfig;
    tax: TaxConfig;
    maxDeltaPercent?: number;
    minDeltaPercent?: number;
    outlierFloorPercent?: number;
    /**
     * Which rule decided the MARKUP (the one the operator is really asking
     * about when a price looks wrong), and every rule that contributed a
     * field. Reporting only — nothing in computePrice() reads them.
     */
    markupRuleId?: string;
    matchedRuleIds?: string[];
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

/** Scope text matching is case- and whitespace-insensitive throughout: feeds
 *  spell the same brand "adidas"/"Adidas", and a rule must not die on that. */
const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();
const sameText = (a: string | undefined, b: string | undefined): boolean => norm(a) === norm(b);

/**
 * The product-identity axes a scope can test. The catalog stores every one of
 * them as its own column, so "which products does this rule cover?" can be
 * answered from a light row read — no variants, no jsonb.
 */
export type ProductScopeAxes = Pick<
    SourceProduct,
    "sku" | "title" | "brand" | "source" | "category" | "secondaryCategory" | "model"
>;

/** The product half of a scope — everything that is not about the size. */
export function productScopeMatches(scope: RuleScope, p: ProductScopeAxes): boolean {
    if (scope.source && !sameText(scope.source, p.source ?? "kicksdb")) return false;
    if (scope.brand && !sameText(scope.brand, p.brand)) return false;
    if (scope.category && !sameText(scope.category, p.category)) return false;
    if (scope.secondaryCategory && !sameText(scope.secondaryCategory, p.secondaryCategory)) {
        return false;
    }
    if (scope.sku && !sameText(scope.sku, p.sku)) return false;
    // "Name contains": the API's model field when it has one, else the title —
    // KicksDB fills `model` ("Jordan 1 Retro High"), feeds only ever send a title.
    if (scope.model) {
        const needle = norm(scope.model);
        if (!norm(p.model).includes(needle) && !norm(p.title).includes(needle)) return false;
    }
    return true;
}

/** True when the scope carries a size constraint (so it covers only part of a product). */
export function scopeTargetsSizes(scope: RuleScope): boolean {
    return scope.sizeType != null || scope.sizeMin != null || scope.sizeMax != null;
}

function scopeMatches(scope: RuleScope, p: SourceProduct, v: SourceVariant): boolean {
    if (!productScopeMatches(scope, p)) return false;
    if (scope.sizeType && !sameText(scope.sizeType, v.sizeType)) return false;
    const sz = sizeToNumber(v.sizeLabel);
    if (scope.sizeMin != null && !(sz >= scope.sizeMin)) return false;
    if (scope.sizeMax != null && !(sz <= scope.sizeMax)) return false;
    return true;
}

/**
 * How narrow each axis is. Counting fields alone gets precedence WRONG: a
 * one-field rule on a single SKU would lose to a two-field family rule, and
 * the operator's most deliberate instruction ("this exact product costs
 * this") would be the one that loses. Weights encode the containment order
 * instead — sku ⊂ model/sub-family ⊂ family ⊂ brand — so the winner is
 * always the rule describing the smallest set of products.
 */
const SCOPE_WEIGHT: Record<keyof RuleScope, number> = {
    source: 1,
    sizeType: 1,
    sizeMin: 1,
    sizeMax: 1,
    brand: 2,
    category: 3,
    secondaryCategory: 4,
    model: 4,
    sku: 10,
};

/** Specificity = summed weight of the constrained fields; higher wins. */
export function scopeSpecificity(scope: RuleScope): number {
    let total = 0;
    for (const [key, value] of Object.entries(scope)) {
        if (value == null || value === "") continue;
        total += SCOPE_WEIGHT[key as keyof RuleScope] ?? 1;
    }
    return total;
}

/** True if the rule states, in any of the three mechanisms, what the margin is. */
export function declaresMarkup(rule: ScopedPricingRule): boolean {
    return rule.markupPercent != null || rule.markupBands != null || rule.markupFixed != null;
}

/**
 * Returns the effective rule for one variant, or null if no rule applies.
 * Less-specific rules provide defaults; more-specific rules override field-by-field.
 *
 * THE MARKUP IS THE EXCEPTION, and it is the whole point of scoped rules: the
 * most specific rule that states a margin owns it OUTRIGHT — its percent, its
 * bands and its fixed € replace all three inherited ones together. Merging
 * them field-by-field is what made a specific rule a no-op: the general rule's
 * dynamic bands cover every ask (their top band is unbounded), so a "Yeezy
 * Foam +60%" rule set the fallback percent and then never got read. Everything
 * that is NOT the margin — rounding, VAT, floors, delta guards, the anomaly
 * nets — still merges field-by-field, so the house defaults keep protecting a
 * family rule that only means to change the margin.
 */
export function resolveEffectiveRule(
    product: SourceProduct,
    variant: SourceVariant,
    config: AppConfig,
): EffectivePricingRule | null {
    const matched = config.pricingRules
        .filter((r) => r.enabled && scopeMatches(r.scope, product, variant))
        .sort((a, b) => scopeSpecificity(a.scope) - scopeSpecificity(b.scope)); // general first

    if (matched.length === 0) return null;

    const merged: Partial<EffectivePricingRule> = {
        sourceDeliveryType: config.source.defaultDeliveryType,
    };
    let markupRuleId: string | undefined;
    for (const r of matched) {
        if (r.sourceDeliveryType != null) merged.sourceDeliveryType = r.sourceDeliveryType;
        // Whole-margin takeover: this rule's mechanism is the only one left.
        if (declaresMarkup(r)) {
            merged.markupPercent = undefined;
            merged.markupBands = undefined;
            merged.markupFixed = undefined;
            markupRuleId = r.id;
            if (r.markupPercent != null) merged.markupPercent = r.markupPercent;
            if (r.markupBands != null) merged.markupBands = sortMarkupBands(r.markupBands);
            if (r.markupFixed != null) merged.markupFixed = r.markupFixed;
        }
        if (r.floor != null) merged.floor = r.floor;
        if (r.minAsks != null) merged.minAsks = r.minAsks;
        if (r.rounding != null) merged.rounding = r.rounding;
        if (r.tax != null) merged.tax = r.tax;
        if (r.maxDeltaPercent != null) merged.maxDeltaPercent = r.maxDeltaPercent;
        if (r.minDeltaPercent != null) merged.minDeltaPercent = r.minDeltaPercent;
        if (r.outlierFloorPercent != null) merged.outlierFloorPercent = r.outlierFloorPercent;
        if (r.minMarginFixed != null) merged.minMarginFixed = r.minMarginFixed;
    }

    // A rule must set a markup somehow: fixed, flat, or banded (whose top band
    // then doubles as the flat fallback for anything the bands miss).
    if (merged.markupPercent == null && merged.markupFixed == null) {
        const bands = merged.markupBands;
        if (!bands || bands.length === 0) return null;
        merged.markupPercent = bands[bands.length - 1].percent;
    }
    return {
        sourceDeliveryType: merged.sourceDeliveryType!,
        markupPercent: merged.markupPercent ?? 0,
        markupBands: merged.markupBands,
        markupFixed: merged.markupFixed,
        floor: merged.floor,
        minAsks: merged.minAsks,
        rounding: merged.rounding ?? { mode: "none" },
        tax: merged.tax ?? { priceIncludesVat: false, vatRatePercent: 0 },
        maxDeltaPercent: merged.maxDeltaPercent,
        minDeltaPercent: merged.minDeltaPercent,
        outlierFloorPercent: merged.outlierFloorPercent,
        minMarginFixed: merged.minMarginFixed,
        markupRuleId,
        matchedRuleIds: matched.map((r) => r.id),
    };
}

/**
 * The rule a product+variant is priced by, without computing a price — the
 * "which rule is this?" question the margins editor and the drawer ask.
 * Returns the winning rule object itself (not the merged effective one), so
 * callers can show its name, scope and margin.
 */
export function resolveMarkupRule(
    product: SourceProduct,
    variant: SourceVariant,
    config: AppConfig,
): ScopedPricingRule | null {
    const eff = resolveEffectiveRule(product, variant, config);
    if (!eff?.markupRuleId) return null;
    return config.pricingRules.find((r) => r.id === eff.markupRuleId) ?? null;
}

/**
 * Which rule sets the margin for a whole product, judged on identity alone.
 * Size-scoped rules are included: they genuinely win for the sizes they name,
 * so callers report those separately rather than pretend they cover nothing.
 * This is the question "does my rule actually do anything?" — asked once per
 * catalog row, off the denormalized columns.
 */
export function winningMarkupRuleId(
    axes: ProductScopeAxes,
    rules: ScopedPricingRule[],
): string | null {
    let winner: ScopedPricingRule | null = null;
    let best = -1;
    for (const r of rules) {
        if (!r.enabled || !declaresMarkup(r)) continue;
        if (!productScopeMatches(r.scope, axes)) continue;
        const weight = scopeSpecificity(r.scope);
        // Ties go to the later rule, matching the resolver's stable sort.
        if (weight >= best) {
            best = weight;
            winner = r;
        }
    }
    return winner?.id ?? null;
}

/** Which of the three mechanisms a rule states its margin with (if any). */
export type MarginKind = "percent" | "fixed" | "bands" | "none";

export function marginKindOf(rule: ScopedPricingRule): MarginKind {
    if (rule.markupBands && rule.markupBands.length > 0) return "bands";
    if (rule.markupFixed != null) return "fixed";
    if (rule.markupPercent != null) return "percent";
    return "none";
}
