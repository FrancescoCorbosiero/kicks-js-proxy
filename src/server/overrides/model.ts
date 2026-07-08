import { skuKey } from "@/lib/skus";

/**
 * Operator overrides that persist independently of the uploaded snapshot, so a
 * choice sticks across re-fetches and re-uploads. Two scopes:
 *
 *  - product: whether a product follows the "preserve manual sale prices" rule.
 *  - variation: a manual, locked price that wins over the StockX-computed price.
 *
 * Keys are derived from stable identities (the parent SKU, and the EU size for a
 * variation) rather than Woo row ids, which can change when a product is
 * re-imported. Stored whole as a single jsonb blob (one active operator).
 */

export interface ProductOverride {
  followSaleRule?: boolean;
}

export interface VariationOverride {
  manualPrice?: number;
}

export interface StoreOverrides {
  products: Record<string, ProductOverride>;
  variations: Record<string, VariationOverride>;
}

export function emptyOverrides(): StoreOverrides {
  return { products: {}, variations: {} };
}

/** Tolerate a missing / partially-shaped blob from the DB. */
export function normalizeOverrides(raw: unknown): StoreOverrides {
  const o = (raw ?? {}) as Partial<StoreOverrides>;
  return {
    products: o.products && typeof o.products === "object" ? o.products : {},
    variations: o.variations && typeof o.variations === "object" ? o.variations : {},
  };
}

/** Stable key for a product-scoped override. */
export function productKey(sku: string): string {
  return skuKey(sku);
}

/** Stable key for a variation-scoped override: parent SKU + EU size. */
export function variationKey(parentSku: string, euSize: string): string {
  return `${skuKey(parentSku)}::${euSize}`;
}

/**
 * Set (or, when `follow` is null, clear) a product's sale-rule choice. Returns a
 * new blob — never mutates the input. Clearing removes the key so the default
 * (follow the sale rule) applies again.
 */
export function withProductSaleRule(
  overrides: StoreOverrides,
  sku: string,
  follow: boolean | null,
): StoreOverrides {
  const products = { ...overrides.products };
  const key = productKey(sku);
  if (follow == null) delete products[key];
  else products[key] = { ...products[key], followSaleRule: follow };
  return { ...overrides, products };
}

/**
 * Set (or, when `price` is null, clear) a variation's manual locked price.
 * Returns a new blob — never mutates the input.
 */
export function withVariationPrice(
  overrides: StoreOverrides,
  parentSku: string,
  euSize: string,
  price: number | null,
): StoreOverrides {
  const variations = { ...overrides.variations };
  const key = variationKey(parentSku, euSize);
  if (price == null) delete variations[key];
  else variations[key] = { ...variations[key], manualPrice: price };
  return { ...overrides, variations };
}

/** The sale-rule choice for a product (default true — preserve sale prices). */
export function followSaleRuleFor(overrides: StoreOverrides, sku: string): boolean {
  return overrides.products[productKey(sku)]?.followSaleRule ?? true;
}

/** The manual locked price for a variation, or null when none is set. */
export function manualPriceFor(
  overrides: StoreOverrides,
  parentSku: string,
  euSize: string,
): number | null {
  return overrides.variations[variationKey(parentSku, euSize)]?.manualPrice ?? null;
}
