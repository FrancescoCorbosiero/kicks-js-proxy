import { z } from "zod";

/**
 * The store round-trip model the operator exports from / imports to WooCommerce
 * (format "rp_cm_roundtrip"). We validate only the few fields we read and use
 * looseObject everywhere so EVERY other field (SEO meta, GMC attributes,
 * descriptions, images, stock, ...) is preserved untouched on the way back out.
 */

const VariationSchema = z.looseObject({
  id: z.number(),
  sku: z.string().nullish(),
  regular_price: z.string().nullish(),
  global_unique_id: z.string().nullish(),
  attributes: z.looseObject({}).nullish(),
});

const ProductSchema = z.looseObject({
  id: z.number(),
  sku: z.string(),
  name: z.string().nullish(),
  variations: z.array(VariationSchema).default([]),
});

export const StoreModelSchema = z.looseObject({
  format: z.string().nullish(),
  version: z.number().nullish(),
  site_url: z.string().nullish(),
  product_count: z.number().nullish(),
  products: z.array(ProductSchema),
});

export interface StoreVariation {
  id: number;
  sku?: string | null;
  regular_price?: string | null;
  sale_price?: string | null;
  global_unique_id?: string | null;
  attributes?: Record<string, unknown> | null;
  [k: string]: unknown;
}
export interface StoreProductModel {
  id: number;
  sku: string;
  name?: string | null;
  variations: StoreVariation[];
  [k: string]: unknown;
}
export interface StoreModel {
  site_url?: string | null;
  product_count?: number | null;
  products: StoreProductModel[];
  [k: string]: unknown;
}

/**
 * Validate the shape, but return the RAW parsed object (not Zod's output) so no
 * field is ever dropped on round-trip. Throws a friendly error on bad input.
 */
export function parseStoreModel(text: string): StoreModel {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  const result = StoreModelSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Store model invalid: ${first?.path.join(".")} — ${first?.message}`);
  }
  return raw as StoreModel;
}
