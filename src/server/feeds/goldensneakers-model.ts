import { z } from "zod";
import type { SourceProduct } from "@core/core-spine";
import { humanEuSize, normSize } from "@/server/store-json/match";
import { skuKey } from "@/lib/skus";

/**
 * GoldenSneakers flat-assortment model: one row per SKU+size, presented_price
 * FINAL (VAT+markup applied upstream via their query params). Pure module —
 * parsing and mapping are unit-tested without HTTP or DB.
 */

export const GsRowSchema = z.looseObject({
  id: z.number(),
  sku: z.string().min(1),
  product_name: z.string().nullish(),
  brand_name: z.string().nullish(),
  barcode: z.union([z.string(), z.number()]).nullish(),
  size_us: z.union([z.string(), z.number()]).nullish(),
  size_eu: z.union([z.string(), z.number()]),
  offer_price: z.number().nullish(),
  presented_price: z.number().nullish(),
  available_quantity: z.number().nullish(),
  image_full_url: z.string().nullish(),
});
export type GsRow = z.infer<typeof GsRowSchema>;

/** A validated, size-normalized GS offer ready for the feed_items table. */
export interface GsOffer {
  sku: string; // canonical (skuKey)
  euNorm: string; // "36.67"
  sizeLabel: string; // "36 2/3"
  sizeUs: string;
  barcode: string;
  offerPrice: number | null;
  presentedPrice: number | null;
  quantity: number;
  productName: string;
  brandName: string;
  image: string;
  raw: unknown;
}

export interface GsParseResult {
  offers: GsOffer[];
  rejected: { index: number; reason: string }[];
}

/**
 * Accept the shapes GS emits: a bare array of rows, a DRF page
 * ({ results: [...] }), or an { items: [...] } wrapper.
 */
export function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.results)) return o.results;
    if (Array.isArray(o.items)) return o.items;
  }
  return [];
}

/**
 * Validate + normalize a raw payload. Rows with an unparseable EU size are
 * rejected (never guessed); duplicate (sku, size) rows collapse to the one
 * with stock, else the last seen — the feed occasionally repeats rows.
 */
export function parseGsPayload(payload: unknown): GsParseResult {
  const rejected: GsParseResult["rejected"] = [];
  const byKey = new Map<string, GsOffer>();

  extractRows(payload).forEach((rawRow, index) => {
    const parsed = GsRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      rejected.push({ index, reason: parsed.error.issues[0]?.message ?? "invalid row" });
      return;
    }
    const row = parsed.data;
    const euRaw = String(row.size_eu);
    const euNorm = normSize(euRaw);
    const sizeLabel = humanEuSize(euRaw);
    if (!euNorm || !sizeLabel) {
      rejected.push({ index, reason: `unparseable EU size "${euRaw}"` });
      return;
    }
    const offer: GsOffer = {
      sku: skuKey(row.sku),
      euNorm,
      sizeLabel,
      sizeUs: row.size_us != null ? String(row.size_us) : "",
      barcode: row.barcode != null ? String(row.barcode) : "",
      offerPrice: row.offer_price ?? null,
      presentedPrice: row.presented_price ?? null,
      quantity: row.available_quantity ?? 0,
      productName: row.product_name ?? "",
      brandName: row.brand_name ?? "",
      image: row.image_full_url ?? "",
      raw: rawRow,
    };
    const key = `${offer.sku}::${offer.euNorm}`;
    const existing = byKey.get(key);
    if (!existing || (existing.quantity === 0 && offer.quantity > 0)) byKey.set(key, offer);
  });

  return { offers: [...byKey.values()], rejected };
}

/**
 * Compose the plan-ready product for a GS-owned SKU. `source:
 * "goldensneakers"` routes it to the passthrough pricing rule, so the
 * presented_price flows through computePrice UNCHANGED (ask = presented,
 * markup 0, bands cleared, no rounding, no VAT). Identity follows the same
 * standard as every other writer: EU-normalized sizes, human labels, barcode
 * as the GTIN.
 */
export function gsOffersToSource(sku: string, offers: GsOffer[], market: string): SourceProduct {
  const first = offers[0];
  return {
    stockxId: `gs:${skuKey(sku)}`,
    sku: skuKey(sku),
    title: first?.productName ?? "",
    brand: first?.brandName ?? "",
    image: first?.image ?? "",
    market,
    currency: "EUR",
    source: "goldensneakers",
    variants: offers
      .filter((o) => o.presentedPrice != null && o.presentedPrice > 0)
      .map((o) => ({
        stockxVariantId: `gs:${skuKey(sku)}:${o.euNorm}`,
        sizeLabel: o.sizeLabel,
        sizeType: "eu",
        sizes: [{ system: "eu", size: o.sizeLabel }],
        upc: o.barcode || undefined,
        offers: [{ deliveryType: "standard" as const, lowestAsk: o.presentedPrice!, asks: o.quantity }],
      })),
  };
}
