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

/** One size variant of a product, as seen on the source (StockX via KicksDB). */
export interface SourceVariant {
    stockxVariantId: string;
    sizeLabel: string;        // e.g. "3.5"
    sizeType: string;         // e.g. "us m"
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

/** Minimal shape of the KicksDB product-endpoint variant we depend on. */
interface KicksVariantRaw {
    id: string;
    size: string;
    size_type: string;
    identifiers?: { identifier: string; identifier_type: string }[] | null;
    prices?: { price: number; asks: number; type: DeliveryType }[] | null;
    currency?: string;
    market?: string;
}
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
// at the variant level, no nested product fields). Add a sibling mapKicksPrices()
// that produces the same SourceVariant[]; everything downstream is identical.

/* ========================================================================== *
 * 3. PRICING-RULE ENGINE  (ask -> your retail price). This is mandatory:
 *    the API gives raw asks, never your shelf price.
 * ========================================================================== */

export interface PricingRule {
    sourceDeliveryType: DeliveryType; // which offer to read from
    markupPercent: number;            // e.g. 12 => +12%
    floor?: number;                   // never price below this
    minAsks?: number;                 // skip variant if liquidity below this
    rounding: "none" | "integer" | "charm"; // charm => .99
}

/** Returns the proposed retail price, or null if the rule says "don't price". */
export function computePrice(variant: SourceVariant, rule: PricingRule): number | null {
    const offer = variant.offers.find((o) => o.deliveryType === rule.sourceDeliveryType);
    if (!offer) return null;
    if (rule.minAsks != null && offer.asks < rule.minAsks) return null;

    let price = offer.lowestAsk * (1 + rule.markupPercent / 100);
    if (rule.floor != null) price = Math.max(price, rule.floor);

    switch (rule.rounding) {
        case "integer": return Math.round(price);
        case "charm": return Math.floor(price) + 0.99;
        default: return Math.round(price * 100) / 100;
    }
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
    rule: PricingRule,
    mappings: Map<string, VariantMapping>, // keyed by stockxVariantId (or by upc)
): Plan {
    const items = product.variants.map<PlanItem>((v) => {
        const proposed = computePrice(v, rule);
        const m = mappings.get(v.stockxVariantId);

        if (proposed == null) {
            return baseItem(v, m, null, "skip", "no priceable offer");
        }
        if (!m) {
            // Not on the store yet -> upsert path would create it.
            return baseItem(v, undefined, proposed, "create");
        }
        const action = m.currentPrice === proposed ? "noop" : "update";
        return baseItem(v, m, proposed, action);
    });

    return {
        sku: product.sku,
        currency: product.currency,
        generatedAt: new Date().toISOString(),
        items,
    };
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

export class WooStoreAdapter implements StorePort {
    constructor(private readonly woo: WooClient) { }

    async resolveMappings(product: SourceProduct): Promise<Map<string, VariantMapping>> {
        // TODO: look up the parent Woo product (by your own SKU/meta), then fetch its
        // variations and match each StockX variant by UPC (global_unique_id) first,
        // falling back to an SKU convention. Persist confirmed matches to your DB so
        // this is cheap on subsequent runs.
        void product;
        return new Map();
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
        // TODO: find existing variable product by SKU; if absent POST /products
        // (type: "variable") then POST /products/{id}/variations/batch with the size
        // variants, writing UPC into global_unique_id so future matching is exact.
        void product;
        return { storeProductId: 0 };
    }
}