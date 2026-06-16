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

const PriceSchema = z.object({
  price: z.number(),
  asks: z.number(),
  type: DeliveryTypeSchema,
});

const IdentifierSchema = z.object({
  identifier: z.string(),
  identifier_type: z.string(),
});

// --- GET /stockx/products ----------------------------------------------------

// Coerce API nulls to undefined so the output matches the mappers' optional
// (`?:`) raw params rather than `T | null`.
const undef = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

export const KicksVariantSchema = z.object({
  id: z.string(),
  size: z.string(),
  size_type: z.string(),
  identifiers: z.array(IdentifierSchema).nullish().transform(undef),
  prices: z.array(PriceSchema).nullish().transform(undef),
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
  data: z.array(KicksProductSchema),
  meta: z
    .object({
      current_page: z.number(),
      per_page: z.number(),
      total: z.number(),
    })
    .nullish(),
});

// --- POST /stockx/prices -----------------------------------------------------
// Flatter: priced variants grouped by product, product metadata may be absent.

export const KicksPricesProductSchema = z.object({
  id: z.string(),
  sku: z.string().nullish().transform(undef),
  title: z.string().nullish().transform(undef),
  brand: z.string().nullish().transform(undef),
  image: z.string().nullish().transform(undef),
  variants: z.array(KicksVariantSchema).nullish().transform(undef),
});

export const KicksPricesResponseSchema = z.object({
  data: z.array(KicksPricesProductSchema),
  meta: z.unknown().nullish(),
});

export type KicksProductsResponse = z.infer<typeof KicksProductsResponseSchema>;
export type KicksPricesResponse = z.infer<typeof KicksPricesResponseSchema>;
