import { z } from "zod";

/**
 * Zod is the boundary: we validate raw KicksDB JSON here, then the pure mappers
 * in core-spine turn it into the domain model. Unknown extra fields are allowed
 * (the API returns far more than we consume).
 */

export const DeliveryTypeSchema = z.enum([
  "standard",
  "express_standard",
  "express_expedited",
]);

type DeliveryType = z.infer<typeof DeliveryTypeSchema>;

/**
 * KicksDB grows new delivery tiers over time, and a strict enum here once
 * failed the ENTIRE bulk-prices response (and with it the store preview) the
 * day a new value appeared. Unknown/missing values become undefined; the
 * mappers drop those rows — pricing only ever reads the configured tier.
 */
const TolerantDeliveryType = z
  .string()
  .nullish()
  .transform((v): DeliveryType | undefined =>
    DeliveryTypeSchema.safeParse(v).success ? (v as DeliveryType) : undefined,
  );

const PriceSchema = z.object({
  price: z.number(),
  asks: z.number(),
  type: TolerantDeliveryType,
});

/** prices[] with unknown-tier entries dropped; empty → undefined so the
 *  mapper's lowest_ask fallback kicks in. */
const PricesArraySchema = z
  .array(PriceSchema)
  .nullish()
  .transform((list) => {
    const kept = (list ?? []).flatMap((p) =>
      p.type == null ? [] : [{ price: p.price, asks: p.asks, type: p.type }],
    );
    return kept.length > 0 ? kept : undefined;
  });

const IdentifierSchema = z.object({
  identifier: z.string(),
  identifier_type: z.string(),
});

// --- GET /stockx/products ----------------------------------------------------

// Coerce API nulls to undefined so the output matches the mappers' optional
// (`?:`) raw params rather than `T | null`.
const undef = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

// Loose: KicksDB size-conversion key names vary; the mapper normalizes them.
const SizeSchema = z.looseObject({});

export const KicksVariantSchema = z.object({
  id: z.string(),
  size: z.string(),
  size_type: z.string(),
  sizes: z.array(SizeSchema).nullish().transform(undef),
  identifiers: z.array(IdentifierSchema).nullish().transform(undef),
  prices: PricesArraySchema,
  lowest_ask: z.number().nullish().transform(undef),
  total_asks: z.number().nullish().transform(undef),
  currency: z.string().nullish().transform(undef),
  market: z.string().nullish().transform(undef),
});

export const KicksProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  title: z.string(),
  brand: z.string(),
  image: z.string().nullish().transform((v) => v ?? ""),
  variants: z.array(KicksVariantSchema).nullish().transform(undef),
});

export const KicksProductsResponseSchema = z.object({
  // "No results" comes back as data: null, not [] — treat both as empty.
  data: z
    .array(KicksProductSchema)
    .nullish()
    .transform((v) => v ?? []),
  meta: z
    .object({
      current_page: z.number(),
      per_page: z.number(),
      total: z.number(),
    })
    .nullish(),
});

// --- POST /stockx/prices -----------------------------------------------------
// Flat: each variant carries id/size/size_type and price/asks/type directly
// (one row per delivery type). No nested prices[]; product id is `product_id`.

const BulkVariantSchema = z.object({
  id: z.string(),
  size: z.string(),
  size_type: z.string(),
  sizes: z.array(SizeSchema).nullish().transform(undef), // present only with show_sizes
  price: z.number().nullish().transform(undef),
  asks: z.number().nullish().transform(undef),
  type: TolerantDeliveryType,
});

export const KicksPricesProductSchema = z.object({
  product_id: z.string(),
  sku: z.string().nullish().transform(undef),
  variants: z.array(BulkVariantSchema).nullish().transform(undef),
});

export const KicksPricesResponseSchema = z.object({
  // A batch where NO SKU matches (e.g. store-only products riding along in
  // the whole-store preview) comes back as data: null — that's an empty
  // result, not an error.
  data: z
    .array(KicksPricesProductSchema)
    .nullish()
    .transform((v) => v ?? []),
  meta: z.unknown().nullish(),
});

export type KicksProductsResponse = z.infer<typeof KicksProductsResponseSchema>;
export type KicksPricesResponse = z.infer<typeof KicksPricesResponseSchema>;
