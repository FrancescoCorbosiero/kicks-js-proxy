/**
 * core-spine.ts
 * -----------------------------------------------------------------------------
 * The framework-agnostic heart of the KicksDB -> store repricing tool.
 * Nothing in this file knows about Next.js, Woo, Shopify, HTTP, or the DB.
 * It defines: the normalized domain model, a mapper from KicksDB responses,
 * a pricing-rule engine, the plan/diff model (preview), and the ports that
 * adapters implement. The Woo REST adapter at the bottom implements StorePort
 * around the one real structural constraint (variation batches are
 * per-parent-product, not global) and backs the live sync path.
 */

import type { AppConfig, EffectivePricingRule, MatchingConfig } from "./config";
import { markupForAsk, resolveEffectiveRule } from "./config";

/* ========================================================================== *
 * 1. DOMAIN MODEL  (the shared language; sources and stores map to/from this)
 * ========================================================================== */

export type DeliveryType = "standard" | "express_standard" | "express_expedited";

/** A single lowest-ask quote for one delivery channel. */
export interface PriceOffer {
    deliveryType: DeliveryType;
    lowestAsk: number; // in the market's main currency, major units (e.g. 174 EUR)
    asks: number;      // depth, useful for "don't reprice on thin liquidity" rules
}

/** One size in a particular sizing system (e.g. { system: "eu", size: "42.5" }). */
export interface SourceSize {
    system: string;           // normalized lowercase: "us m", "eu", "uk", "cm", ...
    size: string;             // e.g. "42.5"
}

/** One size variant of a product, as seen on the source (StockX via KicksDB). */
export interface SourceVariant {
    stockxVariantId: string;
    sizeLabel: string;        // e.g. "3.5" (the variant's primary/default system)
    sizeType: string;         // e.g. "us m"
    sizes?: SourceSize[];     // all known conversions (EU/UK/CM/...), when provided
    upc?: string;             // join key against Woo's global_unique_id
    offers: PriceOffer[];     // empty if the variant has no asks
}

/** A product in our normalized shape, scoped to one market/currency. */
export interface SourceProduct {
    stockxId: string;
    sku: string;              // StockX style code, e.g. "CT8012-047"
    title: string;
    brand: string;
    image: string;
    market: string;           // "IT"
    currency: string;         // "EUR"
    /** Which source produced this product: absent = "kicksdb"; feeds set their
     *  name (e.g. "goldensneakers") so source-scoped pricing rules apply. */
    source?: string;
    variants: SourceVariant[];
    // Optional catalog metadata (KicksDB sends it; feeds usually don't).
    model?: string;           // silhouette, e.g. "Jordan 1 Retro High"
    gender?: string;          // "men" | "women" | "child" | ...
    category?: string;        // e.g. "Air Jordan"
    secondaryCategory?: string; // e.g. "One"
    productType?: string;     // e.g. "sneakers"
    description?: string;
    /** Extra product shots, deduped and excluding `image` itself. */
    gallery?: string[];
}

/* ========================================================================== *
 * 2. KICKSDB MAPPING  (raw API JSON -> domain). Validate with Zod upstream.
 * ========================================================================== */

/** Loose shape of a size-conversion entry; KicksDB key names vary, so be tolerant. */
interface KicksSizeRaw {
    size?: string | number;
    value?: string | number;
    size_type?: string;
    type?: string;
    system?: string;
}

/** Minimal shape of the KicksDB product-endpoint variant we depend on. */
interface KicksVariantRaw {
    id: string;
    size: string;
    size_type: string;
    sizes?: KicksSizeRaw[] | null;
    identifiers?: { identifier: string; identifier_type: string }[] | null;
    prices?: { price: number; asks: number; type: DeliveryType }[] | null;
    lowest_ask?: number | null;   // variant-level ask on the products/search endpoint
    total_asks?: number | null;
    currency?: string;
    market?: string;
}

const normalizeSizes = (v: { sizes?: KicksSizeRaw[] | null }): SourceSize[] =>
    (v.sizes ?? [])
        .map((s) => ({
            system: String(s.size_type ?? s.type ?? s.system ?? "").toLowerCase().trim(),
            size: String(s.size ?? s.value ?? "").trim(),
        }))
        .filter((s) => s.size.length > 0);

/**
 * One offer per delivery tier — the invariant every price consumer relies on.
 * The API can emit several rows for the same variant AND tier with different
 * prices (StockX payloads carry more price kinds than the lowest ask — their
 * own 500s mention sell_faster fields — and one SKU can come back split across
 * entries). With duplicates, computePrice's find() made the shelf price depend
 * on arbitrary row order: sometimes the real ask, sometimes a lower value —
 * which is how products end up on the store far below market. Keep the HIGHEST
 * price per tier: the real lowest ask is never below a conflicting sibling row,
 * so max never undersells; at worst it prices conservatively. Conflicts are
 * logged so the upstream cause stays visible in ops logs.
 */
export function collapseOffersByTier(offers: PriceOffer[], context: string): PriceOffer[] {
    if (offers.length < 2) return offers;
    const byTier = new Map<DeliveryType, PriceOffer>();
    let conflict = false;
    for (const o of offers) {
        const cur = byTier.get(o.deliveryType);
        if (!cur) {
            byTier.set(o.deliveryType, o);
            continue;
        }
        if (o.lowestAsk !== cur.lowestAsk) conflict = true;
        if (o.lowestAsk > cur.lowestAsk) byTier.set(o.deliveryType, o);
    }
    if (conflict) {
        console.warn(
            `[prices] conflicting same-tier price rows for ${context} — kept the highest per tier`,
        );
    }
    return [...byTier.values()];
}

/**
 * Build offers from the per-delivery-type prices[] when present; otherwise fall
 * back to the variant-level lowest_ask/total_asks (the products/search endpoint
 * carries the ask there, with prices[] often empty).
 */
const normalizeOffers = (v: KicksVariantRaw, context: string): PriceOffer[] => {
    const offers = collapseOffersByTier(
        (v.prices ?? []).map((p) => ({
            deliveryType: p.type,
            lowestAsk: p.price,
            asks: p.asks,
        })),
        context,
    );
    if (offers.length === 0 && v.lowest_ask != null && v.lowest_ask > 0) {
        return [{ deliveryType: "standard", lowestAsk: v.lowest_ask, asks: v.total_asks ?? 0 }];
    }
    return offers;
};
interface KicksProductRaw {
    id: string;
    sku: string;
    title: string;
    brand: string;
    image: string;
    variants?: KicksVariantRaw[];
    model?: string;
    gender?: string;
    category?: string;
    secondary_category?: string;
    product_type?: string;
    description?: string;
    gallery?: string[];
}

const pickUpc = (v: KicksVariantRaw): string | undefined =>
    v.identifiers?.find((i) => i.identifier_type === "UPC")?.identifier;

export function mapKicksProduct(raw: KicksProductRaw, market: string): SourceProduct {
    const variants = (raw.variants ?? []).map<SourceVariant>((v) => ({
        stockxVariantId: v.id,
        sizeLabel: v.size,
        sizeType: v.size_type,
        sizes: normalizeSizes(v),
        upc: pickUpc(v),
        offers: normalizeOffers(v, `${raw.sku} ${v.size} ${v.size_type}`),
    }));
    const currency = raw.variants?.[0]?.currency ?? "EUR";
    // The gallery's first entries usually duplicate the thumbnail verbatim.
    const gallery = [...new Set(raw.gallery ?? [])].filter((u) => u && u !== raw.image);
    return {
        stockxId: raw.id,
        sku: raw.sku,
        title: raw.title,
        brand: raw.brand,
        image: raw.image,
        market,
        currency,
        variants,
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.gender ? { gender: raw.gender } : {}),
        ...(raw.category ? { category: raw.category } : {}),
        ...(raw.secondary_category ? { secondaryCategory: raw.secondary_category } : {}),
        ...(raw.product_type ? { productType: raw.product_type } : {}),
        ...(raw.description ? { description: raw.description } : {}),
        ...(gallery.length > 0 ? { gallery } : {}),
    };
}
// NOTE: the batch-prices endpoint returns a flatter variant shape (price/asks/type
// at the variant level, no nested product fields). The sibling mapKicksPrices()
// below produces the same SourceVariant[]; everything downstream is identical.

/** Raw shape of the batch-prices endpoint: product_id + flat variant rows, each
 *  carrying price/asks/type directly (one row per delivery type, no prices[]). */
interface KicksBulkVariantRaw {
    id: string;
    size: string;
    size_type: string;
    sizes?: KicksSizeRaw[] | null;
    price?: number | null;
    asks?: number | null;
    type?: DeliveryType | null;
}
interface KicksPricesProductRaw {
    product_id: string;
    sku?: string;
    variants?: KicksBulkVariantRaw[];
}

export function mapKicksPrices(raw: KicksPricesProductRaw, market: string): SourceProduct {
    // The flat rows may repeat a variant id once per delivery type -> group them.
    const byId = new Map<string, KicksBulkVariantRaw[]>();
    for (const v of raw.variants ?? []) {
        const list = byId.get(v.id) ?? [];
        list.push(v);
        byId.set(v.id, list);
    }

    const variants = [...byId.values()].map<SourceVariant>((rows) => {
        const first = rows[0];
        return {
            stockxVariantId: first.id,
            sizeLabel: first.size,
            sizeType: first.size_type,
            sizes: normalizeSizes(first),
            // price 0 == no ask at that delivery tier (e.g. express rows) -> drop.
            offers: collapseOffersByTier(
                rows
                    .filter((r) => r.type != null && r.price != null && r.price > 0)
                    .map((r) => ({ deliveryType: r.type!, lowestAsk: r.price!, asks: r.asks ?? 0 })),
                `${raw.sku ?? raw.product_id} ${first.size} ${first.size_type}`,
            ),
        };
    });

    return {
        stockxId: raw.product_id,
        sku: raw.sku ?? "",
        title: "",
        brand: "",
        image: "",
        market,
        currency: "EUR",
        variants,
    };
}

/**
 * Collapse duplicate products (same SKU, case/space-insensitive) into one.
 * The bulk endpoint can return one SKU as several entries (and a messy input
 * list can request it several times); left unmerged, each copy became its own
 * preview plan — the same product N times, N× the variants "ready to write".
 * Variants merge by id; conflicting same-tier offers across copies collapse to
 * the highest price (see collapseOffersByTier) — entry order must never decide
 * the shelf price.
 */
export function mergeProductsBySku(products: SourceProduct[]): SourceProduct[] {
    const bySku = new Map<string, SourceProduct>();
    for (const p of products) {
        const key = p.sku.trim().toUpperCase();
        const cur = bySku.get(key);
        if (!cur) {
            bySku.set(key, p);
            continue;
        }
        const byVid = new Map(cur.variants.map((v) => [v.stockxVariantId, v]));
        for (const v of p.variants) {
            const existing = byVid.get(v.stockxVariantId);
            if (!existing) {
                byVid.set(v.stockxVariantId, v);
                continue;
            }
            if (v.offers.length > 0) {
                byVid.set(v.stockxVariantId, {
                    ...existing,
                    offers: collapseOffersByTier(
                        [...existing.offers, ...v.offers],
                        `${key} ${existing.sizeLabel} ${existing.sizeType} (merged entries)`,
                    ),
                });
            }
        }
        bySku.set(key, {
            ...cur,
            // Keep the richest identity fields seen across the copies.
            title: cur.title || p.title,
            brand: cur.brand || p.brand,
            image: cur.image || p.image,
            variants: [...byVid.values()],
        });
    }
    return [...bySku.values()];
}

/* ========================================================================== *
 * 3. PRICING-RULE ENGINE  (ask -> your retail price). This is mandatory:
 *    the API gives raw asks, never your shelf price.
 * ========================================================================== */

/**
 * Legacy flat rule shape. Retained for back-compat / readability; the canonical
 * input to computePrice() is `EffectivePricingRule` (config.ts), produced per
 * variant by resolveEffectiveRule().
 */
export interface PricingRule {
    sourceDeliveryType: DeliveryType; // which offer to read from
    markupPercent: number;            // e.g. 12 => +12%
    floor?: number;                   // never price below this
    minAsks?: number;                 // skip variant if liquidity below this
    rounding: "none" | "integer" | "charm"; // charm => .99
}

/** Apply a RoundingConfig (mode + increment) to a price. */
export function roundPrice(price: number, rounding: EffectivePricingRule["rounding"]): number {
    switch (rounding.mode) {
        case "integer":
            return Math.round(price);
        case "charm": {
            // increment is the charm tail, e.g. .99 => floor + .99, .95 => floor + .95
            const tail = rounding.increment ?? 0.99;
            return Math.floor(price) + tail;
        }
        case "nearest": {
            // increment is the step, e.g. 5 => nearest multiple of 5
            const step = rounding.increment ?? 1;
            return step > 0 ? Math.round(price / step) * step : price;
        }
        case "none":
        default:
            return Math.round(price * 100) / 100;
    }
}

/**
 * Median ask across a product's variants at one delivery tier — the reference
 * the outlier guard measures against. Null when fewer than 3 sizes carry an
 * ask: a median of one or two prices is no distribution at all.
 */
export function medianTierAsk(product: SourceProduct, deliveryType: DeliveryType): number | null {
    const asks = product.variants
        .map((v) => v.offers.find((o) => o.deliveryType === deliveryType)?.lowestAsk ?? 0)
        .filter((a) => a > 0)
        .sort((a, b) => a - b);
    if (asks.length < 3) return null;
    const mid = Math.floor(asks.length / 2);
    return asks.length % 2 === 1 ? asks[mid] : (asks[mid - 1] + asks[mid]) / 2;
}

/** Context a caller can pass to computePrice for product-level guards. */
export interface PriceContext {
    /** medianTierAsk() of the product — enables outlierFloorPercent. */
    medianAsk?: number | null;
}

/**
 * Returns the proposed retail price for a variant under an effective rule, or
 * null if the rule says "don't price" (no offer for the chosen delivery type,
 * or liquidity below minAsks). Applies, in order: delivery-type selection,
 * minAsks skip, the distribution guard (an ask far below the product's median
 * is treated as bad data and lifted to the floor), markup (banded by the raw
 * ask when markupBands is set), floor, VAT, rounding. The maxDeltaPercent
 * guardrail is NOT applied here — it is a plan-time compare against the
 * current price.
 */
export function computePrice(
    variant: SourceVariant,
    rule: EffectivePricingRule,
    context: PriceContext = {},
): number | null {
    const offer = variant.offers.find((o) => o.deliveryType === rule.sourceDeliveryType);
    if (!offer) return null;
    if (rule.minAsks != null && offer.asks < rule.minAsks) return null;

    // Distribution guard: one size never wildly undercuts its own product.
    // Asks ABOVE the median are never touched — expensive sizes are safe.
    let ask = offer.lowestAsk;
    if (
        rule.outlierFloorPercent != null &&
        rule.outlierFloorPercent > 0 &&
        context.medianAsk != null &&
        context.medianAsk > 0
    ) {
        ask = Math.max(ask, (context.medianAsk * rule.outlierFloorPercent) / 100);
    }

    let price = ask * (1 + markupForAsk(ask, rule) / 100);
    if (rule.floor != null) price = Math.max(price, rule.floor);
    if (rule.tax.priceIncludesVat && rule.tax.vatRatePercent) {
        price = price * (1 + rule.tax.vatRatePercent / 100);
    }
    return roundPrice(price, rule.rounding);
}

/* ========================================================================== *
 * 4. PLAN / DIFF  (this IS the preview; "Apply" just executes it)
 * ========================================================================== */

export type PlanAction = "update" | "create" | "noop" | "skip";

export interface PlanItem {
    stockxVariantId: string;
    sizeLabel: string;
    upc?: string;
    // store linkage (resolved from the mapping table); null => not yet on store
    storeProductId: number | null;
    storeVariationId: number | null;
    currentPrice: number | null;
    proposedPrice: number | null;
    /**
     * Desired MANAGED stock quantity — set only for stock-managed sources
     * (feeds with finite supply, e.g. GoldenSneakers). undefined = the source
     * carries no stock truth (KicksDB): never touch the store's stock fields.
     * An "update" may be stock-only (proposedPrice null, stockQuantity set).
     */
    stockQuantity?: number;
    action: PlanAction;
    reason?: string; // e.g. "no offer for chosen delivery type", "below minAsks"
    locked?: boolean; // operator-set manual price wins over the computed price
}

export interface Plan {
    sku: string;
    currency: string;
    generatedAt: string;
    items: PlanItem[];
}

/** A resolved mapping row: StockX variant <-> Woo variation. */
export interface VariantMapping {
    stockxVariantId: string;
    storeProductId: number;
    storeVariationId: number;
    currentPrice: number | null;
    /** The store's MANAGED stock quantity; null = unmanaged (sell on demand). */
    currentStock?: number | null;
    saleActive?: boolean; // store variation has a manual discount (sale_price) -> preserve it
    manualPrice?: number | null; // operator-locked price: wins over the computed price
}

/** Per-product knobs for buildPlan; all optional so existing callers are unaffected. */
export interface BuildPlanOptions {
    // Preserve variations that carry a manual discount (sale_price). Default true —
    // the historical behaviour. Set false, per product, to reprice discounted
    // variations too.
    followSaleRule?: boolean;
    /**
     * The source carries FINITE stock truth (a supplier feed, not KicksDB):
     * the variant's offer depth is a real quantity, stock drift alone makes a
     * row actionable (stock-only updates), and quantities are written to the
     * store. Default false — KicksDB behaviour, stock never touched.
     */
    manageStockFromSource?: boolean;
}

export function buildPlan(
    product: SourceProduct,
    config: AppConfig,
    mappings: Map<string, VariantMapping>, // keyed by stockxVariantId (or by upc)
    options: BuildPlanOptions = {},
): Plan {
    const followSaleRule = options.followSaleRule ?? true;
    const manageStock = options.manageStockFromSource ?? false;

    /** Real quantity at the source (offer depth of the primary offer). */
    const qtyOf = (v: SourceVariant): number => {
        const offer =
            v.offers.find((o) => o.deliveryType === config.source.defaultDeliveryType) ?? v.offers[0];
        return offer?.asks ?? 0;
    };

    const items = product.variants.map<PlanItem>((v) => {
        const m = mappings.get(v.stockxVariantId);
        const qty = manageStock ? qtyOf(v) : undefined;
        // Unmanaged store stock counts as drift: finite supply must be managed.
        const stockChanged =
            manageStock && m != null && (m.currentStock == null || m.currentStock !== qty);
        const stock = (item: PlanItem): PlanItem =>
            qty !== undefined ? { ...item, stockQuantity: qty } : item;

        // Highest precedence: an operator-locked manual price. It wins over the
        // sale rule and the computed price, and never drifts on re-runs. Only
        // meaningful for a variation that exists on the store (has a mapping).
        if (m && m.manualPrice != null) {
            const action = m.currentPrice === m.manualPrice && !stockChanged ? "noop" : "update";
            return {
                ...stock(baseItem(v, m, m.manualPrice, action, "manual price (locked)")),
                locked: true,
            };
        }

        const rule = resolveEffectiveRule(product, v, config);
        const proposed = rule
            ? computePrice(v, rule, { medianAsk: medianTierAsk(product, rule.sourceDeliveryType) })
            : null;

        if (proposed == null) {
            const reason = rule ? "no priceable offer" : "no pricing rule matches";
            // Finite supply: an unpriceable size (typically qty 0) must still
            // sync its quantity — otherwise the store keeps selling it.
            if (m && stockChanged) {
                return stock(baseItem(v, m, null, "update", `stock only — ${reason}`));
            }
            return baseItem(v, m, null, "skip", reason);
        }
        if (!m) {
            // Not on the store yet -> upsert path would create it.
            return stock(baseItem(v, undefined, proposed, "create"));
        }
        if (m.saleActive && followSaleRule) {
            // Owner-set discount wins on PRICE — but finite stock still syncs.
            if (stockChanged) {
                return stock(baseItem(v, m, null, "update", "stock only — sale price preserved"));
            }
            return baseItem(v, m, proposed, "skip", "discounted — sale price preserved");
        }
        if (m.currentPrice === proposed) {
            if (stockChanged) {
                return stock(baseItem(v, m, proposed, "update", "stock change"));
            }
            return stock(baseItem(v, m, proposed, "noop"));
        }
        // Anti-churn threshold: a drift of at most minDeltaPercent is "close
        // enough" — noop, so tiny ask movements never turn into store writes.
        if (
            rule!.minDeltaPercent != null &&
            m.currentPrice != null &&
            !exceedsDelta(m.currentPrice, proposed, rule!.minDeltaPercent)
        ) {
            if (stockChanged) {
                return stock(baseItem(v, m, null, "update", "stock only — price within minDeltaPercent"));
            }
            return stock(
                baseItem(v, m, proposed, "noop", `within minDeltaPercent (${rule!.minDeltaPercent}%)`),
            );
        }
        // Plan-time guardrail: reject a change larger than maxDeltaPercent.
        if (
            rule!.maxDeltaPercent != null &&
            m.currentPrice != null &&
            exceedsDelta(m.currentPrice, proposed, rule!.maxDeltaPercent)
        ) {
            if (stockChanged) {
                return stock(
                    baseItem(v, m, null, "update", `stock only — price exceeds maxDeltaPercent`),
                );
            }
            return baseItem(
                v,
                m,
                proposed,
                "skip",
                `change exceeds maxDeltaPercent (${rule!.maxDeltaPercent}%)`,
            );
        }
        return stock(baseItem(v, m, proposed, "update"));
    });

    return {
        sku: product.sku,
        currency: product.currency,
        generatedAt: new Date().toISOString(),
        items,
    };
}

/** True if |proposed - current| / |current| (as a percent) exceeds maxPercent. */
function exceedsDelta(current: number, proposed: number, maxPercent: number): boolean {
    if (current === 0) return proposed !== 0; // any change off a zero base is "infinite"
    return (Math.abs(proposed - current) / Math.abs(current)) * 100 > maxPercent;
}

function baseItem(
    v: SourceVariant,
    m: VariantMapping | undefined,
    proposed: number | null,
    action: PlanAction,
    reason?: string,
): PlanItem {
    return {
        stockxVariantId: v.stockxVariantId,
        sizeLabel: v.sizeLabel,
        upc: v.upc,
        storeProductId: m?.storeProductId ?? null,
        storeVariationId: m?.storeVariationId ?? null,
        currentPrice: m?.currentPrice ?? null,
        proposedPrice: proposed,
        action,
        reason,
    };
}

/* ========================================================================== *
 * 5. PORTS  (the only seams the rest of the app talks through)
 * ========================================================================== */

export interface SourcePort {
    /** Up to 50 SKUs per call -> caller chunks. */
    getPricesBatch(skus: string[], market: string): Promise<SourceProduct[]>;
    getProduct(query: string, market: string): Promise<SourceProduct[]>;
}

export interface ApplyResult {
    updated: number;
    failed: { stockxVariantId: string; error: string }[];
}

export interface StorePort {
    /** Resolve StockX variants to store variations (by UPC, then SKU convention). */
    resolveMappings(product: SourceProduct): Promise<Map<string, VariantMapping>>;
    /** Execute the price changes in a plan. Idempotent: noop items are skipped. */
    applyPrices(plan: Plan): Promise<ApplyResult>;
    /** Create or update the product + its variations from source data. */
    upsertProduct(product: SourceProduct): Promise<{ storeProductId: number }>;
}

/* ========================================================================== *
 * 6. WOOCOMMERCE ADAPTER  (skeleton — the only adapter built at launch)
 *    Key constraint: variation prices CANNOT go through /products/batch.
 *    They must be grouped by parent product and sent to
 *    POST /products/{productId}/variations/batch  -> one call per product.
 * ========================================================================== */

interface WooClient {
    // thin wrapper over fetch with consumer key/secret basic auth, base URL, retries
    post<T>(path: string, body: unknown): Promise<T>;
    get<T>(path: string, query?: Record<string, string>): Promise<T>;
}

/** Minimal Woo shapes we read. */
interface WooProduct {
    id: number;
    sku?: string;
}
interface WooVariation {
    id: number;
    sku?: string;
    global_unique_id?: string;
    regular_price?: string;
}

const parsePrice = (s?: string): number | null => {
    if (s == null || s === "") return null;
    const n = Number.parseFloat(s);
    return Number.isNaN(n) ? null : n;
};

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Render a Woo variation SKU from the configured template. Tokens:
 * {sku} {size} {sizeType} {brand}. e.g. "{sku}-{sizeType}-{size}".
 */
export function renderSkuTemplate(
    template: string,
    product: Pick<SourceProduct, "sku" | "brand">,
    variant: Pick<SourceVariant, "sizeLabel" | "sizeType">,
): string {
    return template
        .replaceAll("{sku}", product.sku)
        .replaceAll("{brand}", product.brand)
        .replaceAll("{size}", variant.sizeLabel)
        .replaceAll("{sizeType}", variant.sizeType)
        .replaceAll(" ", "-");
}

const DEFAULT_MATCHING: MatchingConfig = {
    strategyOrder: ["upc", "skuPattern", "manual"],
    skuTemplate: "{sku}-{size}",
};

export class WooStoreAdapter implements StorePort {
    private readonly matching: MatchingConfig;

    constructor(private readonly woo: WooClient, matching: MatchingConfig = DEFAULT_MATCHING) {
        this.matching = matching;
    }

    /** Find the parent Woo product whose SKU equals the StockX style code. */
    private async findParent(product: SourceProduct): Promise<WooProduct | undefined> {
        const found = await this.woo.get<WooProduct[]>("products", { sku: product.sku });
        return Array.isArray(found) ? found[0] : undefined;
    }

    private async listVariations(productId: number): Promise<WooVariation[]> {
        const v = await this.woo.get<WooVariation[]>(`products/${productId}/variations`, {
            per_page: "100",
        });
        return Array.isArray(v) ? v : [];
    }

    async resolveMappings(product: SourceProduct): Promise<Map<string, VariantMapping>> {
        const map = new Map<string, VariantMapping>();
        const parent = await this.findParent(product);
        if (!parent) return map; // not on the store yet -> everything is a "create"

        const variations = await this.listVariations(parent.id);
        const byUpc = new Map<string, WooVariation>();
        const bySku = new Map<string, WooVariation>();
        for (const v of variations) {
            if (v.global_unique_id) byUpc.set(v.global_unique_id, v);
            if (v.sku) bySku.set(v.sku, v);
        }

        for (const variant of product.variants) {
            let match: WooVariation | undefined;
            for (const strat of this.matching.strategyOrder) {
                if (match) break;
                if (strat === "upc" && variant.upc) match = byUpc.get(variant.upc);
                else if (strat === "skuPattern")
                    match = bySku.get(renderSkuTemplate(this.matching.skuTemplate, product, variant));
                // "manual" has no automatic resolution
            }
            if (match) {
                map.set(variant.stockxVariantId, {
                    stockxVariantId: variant.stockxVariantId,
                    storeProductId: parent.id,
                    storeVariationId: match.id,
                    currentPrice: parsePrice(match.regular_price),
                });
            }
        }
        return map;
    }

    async applyPrices(plan: Plan): Promise<ApplyResult> {
        const result: ApplyResult = { updated: 0, failed: [] };

        // Group actionable items by parent product -> one batch call each.
        const byProduct = new Map<number, PlanItem[]>();
        for (const item of plan.items) {
            if (item.action !== "update" && item.action !== "create") continue;
            if (item.storeProductId == null) continue; // 'create' handled via upsertProduct
            const list = byProduct.get(item.storeProductId) ?? [];
            list.push(item);
            byProduct.set(item.storeProductId, list);
        }

        for (const [productId, items] of byProduct) {
            const update = items
                .filter((i) => i.storeVariationId != null && i.proposedPrice != null)
                .map((i) => ({
                    id: i.storeVariationId!,
                    regular_price: i.proposedPrice!.toFixed(2), // Woo expects a string
                }));
            if (update.length === 0) continue;

            try {
                await this.woo.post(`products/${productId}/variations/batch`, { update });
                result.updated += update.length;
            } catch (e) {
                for (const i of items) {
                    result.failed.push({
                        stockxVariantId: i.stockxVariantId,
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            }
        }
        return result;
    }

    async upsertProduct(product: SourceProduct): Promise<{ storeProductId: number }> {
        // 1. Find or create the parent variable product (keyed by StockX style code).
        let parent = await this.findParent(product);
        if (!parent) {
            const created = await this.woo.post<WooProduct>("products", {
                name: product.title,
                type: "variable",
                sku: product.sku,
                images: product.image ? [{ src: product.image }] : [],
                attributes: [
                    {
                        name: "Size",
                        variation: true,
                        visible: true,
                        options: uniq(product.variants.map((v) => v.sizeLabel)),
                    },
                ],
            });
            parent = { id: created.id, sku: product.sku };
        }

        // 2. Create any missing variations, writing UPC into global_unique_id so
        //    future matching is exact. Existing ones (by sku/upc) are left alone.
        const existing = await this.listVariations(parent.id);
        const existingSkus = new Set(existing.map((v) => v.sku).filter(Boolean));
        const existingUpcs = new Set(existing.map((v) => v.global_unique_id).filter(Boolean));

        const create = product.variants
            .map((v) => ({
                variant: v,
                sku: renderSkuTemplate(this.matching.skuTemplate, product, v),
            }))
            .filter(({ variant, sku }) => {
                if (existingSkus.has(sku)) return false;
                if (variant.upc && existingUpcs.has(variant.upc)) return false;
                return true;
            })
            .map(({ variant, sku }) => ({
                sku,
                global_unique_id: variant.upc,
                attributes: [{ name: "Size", option: variant.sizeLabel }],
            }));

        if (create.length > 0) {
            await this.woo.post(`products/${parent.id}/variations/batch`, { create });
        }
        return { storeProductId: parent.id };
    }
}