/**
 * core-spine.ts
 * -----------------------------------------------------------------------------
 * The framework-agnostic heart of the StockX -> store repricing tool.
 * Nothing in this file knows about Next.js, Woo, Shopify, HTTP, or the DB.
 * It defines: the normalized domain model, a mapper from KicksDB responses,
 * a pricing-rule engine, the plan/diff model (preview), and the ports that
 * adapters implement. The Woo adapter at the bottom is a skeleton showing the
 * one real structural constraint (batch is per-parent-product, not global).
 *
 * Swap-in points are marked with TODO. This compiles conceptually; wire the
 * TODOs to your HTTP client and DB.
 */

import type { AppConfig, EffectivePricingRule, MatchingConfig } from "./config";
import { resolveEffectiveRule } from "./config";

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
    variants: SourceVariant[];
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
    currency?: string;
    market?: string;
}

const normalizeSizes = (v: KicksVariantRaw): SourceSize[] =>
    (v.sizes ?? [])
        .map((s) => ({
            system: String(s.size_type ?? s.type ?? s.system ?? "").toLowerCase().trim(),
            size: String(s.size ?? s.value ?? "").trim(),
        }))
        .filter((s) => s.size.length > 0);
interface KicksProductRaw {
    id: string;
    sku: string;
    title: string;
    brand: string;
    image: string;
    variants?: KicksVariantRaw[];
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
        offers: (v.prices ?? []).map((p) => ({
            deliveryType: p.type,
            lowestAsk: p.price,
            asks: p.asks,
        })),
    }));
    const currency = raw.variants?.[0]?.currency ?? "EUR";
    return {
        stockxId: raw.id,
        sku: raw.sku,
        title: raw.title,
        brand: raw.brand,
        image: raw.image,
        market,
        currency,
        variants,
    };
}
// NOTE: the batch-prices endpoint returns a flatter variant shape (price/asks/type
// at the variant level, no nested product fields). The sibling mapKicksPrices()
// below produces the same SourceVariant[]; everything downstream is identical.

/** Raw shape of the batch-prices endpoint: priced variants grouped by product,
 *  but product metadata (title/brand/image/sku) may be absent. Validate w/ Zod. */
interface KicksPricesProductRaw {
    id: string;
    sku?: string;
    title?: string;
    brand?: string;
    image?: string;
    variants?: KicksVariantRaw[];
}

export function mapKicksPrices(raw: KicksPricesProductRaw, market: string): SourceProduct {
    const variants = (raw.variants ?? []).map<SourceVariant>((v) => ({
        stockxVariantId: v.id,
        sizeLabel: v.size,
        sizeType: v.size_type,
        sizes: normalizeSizes(v),
        upc: pickUpc(v),
        offers: (v.prices ?? []).map((p) => ({
            deliveryType: p.type,
            lowestAsk: p.price,
            asks: p.asks,
        })),
    }));
    const currency = raw.variants?.[0]?.currency ?? "EUR";
    return {
        stockxId: raw.id,
        sku: raw.sku ?? "",
        title: raw.title ?? "",
        brand: raw.brand ?? "",
        image: raw.image ?? "",
        market,
        currency,
        variants,
    };
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
 * Returns the proposed retail price for a variant under an effective rule, or
 * null if the rule says "don't price" (no offer for the chosen delivery type,
 * or liquidity below minAsks). Applies, in order: delivery-type selection,
 * minAsks skip, markup, floor, VAT, rounding. The maxDeltaPercent guardrail is
 * NOT applied here — it is a plan-time compare against the current price.
 */
export function computePrice(variant: SourceVariant, rule: EffectivePricingRule): number | null {
    const offer = variant.offers.find((o) => o.deliveryType === rule.sourceDeliveryType);
    if (!offer) return null;
    if (rule.minAsks != null && offer.asks < rule.minAsks) return null;

    let price = offer.lowestAsk * (1 + rule.markupPercent / 100);
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
    action: PlanAction;
    reason?: string; // e.g. "no offer for chosen delivery type", "below minAsks"
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
}

export function buildPlan(
    product: SourceProduct,
    config: AppConfig,
    mappings: Map<string, VariantMapping>, // keyed by stockxVariantId (or by upc)
): Plan {
    const items = product.variants.map<PlanItem>((v) => {
        const rule = resolveEffectiveRule(product, v, config);
        const m = mappings.get(v.stockxVariantId);

        if (!rule) {
            return baseItem(v, m, null, "skip", "no pricing rule matches");
        }

        const proposed = computePrice(v, rule);
        if (proposed == null) {
            return baseItem(v, m, null, "skip", "no priceable offer");
        }
        if (!m) {
            // Not on the store yet -> upsert path would create it.
            return baseItem(v, undefined, proposed, "create");
        }
        if (m.currentPrice === proposed) {
            return baseItem(v, m, proposed, "noop");
        }
        // Plan-time guardrail: reject a change larger than maxDeltaPercent.
        if (
            rule.maxDeltaPercent != null &&
            m.currentPrice != null &&
            exceedsDelta(m.currentPrice, proposed, rule.maxDeltaPercent)
        ) {
            return baseItem(
                v,
                m,
                proposed,
                "skip",
                `change exceeds maxDeltaPercent (${rule.maxDeltaPercent}%)`,
            );
        }
        return baseItem(v, m, proposed, "update");
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