import { z } from "zod";
import type { SourceProduct } from "@core/core-spine";
import { classifyTitle } from "@/server/catalog/classify";
import { humanEuSize, normSize } from "@/server/store-json/match";
import { skuKey } from "@/lib/skus";
import { normalizeGtin } from "@/lib/gtin";

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
  // The feed carries the main picture under BOTH names, and rows exist where
  // only one of them is filled.
  image: z.string().nullish(),
  image_full_url: z.string().nullish(),
  image_name: z.string().nullish(),
  additional_images: z.array(z.union([z.string(), z.looseObject({})])).nullish(),
});
export type GsRow = z.infer<typeof GsRowSchema>;

/**
 * Origin a site-relative image path hangs off. Some GS rows ship
 * `image_full_url` as a bare path ("/images/IH6001/main/") instead of a URL;
 * the provider won't fix it, so we re-attach the origin they left out.
 */
export const GS_IMAGE_BASE = "https://www.goldensneakers.net";

/**
 * Turn whatever the feed put in `image_full_url` into an absolute URL, or null
 * when it is not a path at all. Trust is NOT decided here — the caller still
 * runs the https + goldensneakers.net gate on the result, so a relative path
 * can never smuggle in a foreign host.
 */
function absoluteImageUrl(raw: string, imageBase: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw; // already absolute
  if (raw.startsWith("//")) return `https:${raw}`; // protocol-relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // data:, javascript:, mailto:…
  // Site-relative — but only when it actually looks like a path: junk such as
  // "not a url" must stay imageless rather than become a plausible 404.
  const looksLikePath = !/\s/.test(raw) && (raw.includes("/") || /\.[a-z0-9]{2,5}$/i.test(raw));
  if (!looksLikePath) return null;
  return `${imageBase.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
}

/**
 * Resolve a feed row's image URL, supporting BOTH formats GS has shipped:
 *  - legacy: image_full_url is a base FOLDER (…/images/SKU/main/) and
 *    image_name holds the file to append;
 *  - current (Aug 2026): image_full_url is already the COMPLETE file URL on
 *    media.goldensneakers.net while image_name still holds just the filename —
 *    blind concatenation would double it (…/x.png/x.png → 404).
 * Either form may arrive site-relative ("/images/SKU/main/") instead of as a
 * URL — the same product, spelled two ways, in the same feed. Those rows used
 * to resolve to "" (product on the catalog with no picture); they are now
 * completed against GS_IMAGE_BASE before the trust gate runs.
 * Only https URLs on goldensneakers.net or a true subdomain are accepted;
 * anything else — http, third-party hosts, lookalikes such as
 * evilgoldensneakers.net — resolves to "" (no image, never a foreign URL).
 */
export function resolveGsImage(
  fullUrl?: string | null,
  name?: string | null,
  imageBase: string = GS_IMAGE_BASE,
): string {
  const raw = (fullUrl ?? "").trim();
  if (!raw) return "";
  const base = absoluteImageUrl(raw, imageBase);
  if (!base) return "";
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return "";
  }
  const host = url.hostname;
  const trusted =
    url.protocol === "https:" &&
    (host === "goldensneakers.net" || host.endsWith(".goldensneakers.net"));
  if (!trusted) return "";

  const file = (name ?? "").trim();
  if (!file) return base;
  const lastSegment = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (lastSegment === file) return base; // already the complete file URL
  return base.replace(/\/+$/, "") + "/" + file; // legacy: folder + filename
}

/**
 * The extra product shots of one row, run through the same sanitizer as the
 * main image. The feed sends them as plain paths, but an object form
 * ({ image, image_name, ... }) is just as plausible from this provider, so
 * both are read; anything else is skipped rather than guessed at.
 */
export function resolveGsGallery(raw: unknown, main: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    let url = "";
    if (typeof entry === "string") url = resolveGsImage(entry, null);
    else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const path = typeof o.image_full_url === "string" ? o.image_full_url : o.image;
      const name = typeof o.image_name === "string" ? o.image_name : null;
      if (typeof path === "string") url = resolveGsImage(path, name);
    }
    if (url && url !== main && !out.includes(url)) out.push(url);
  }
  return out;
}

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
  /** Extra product shots, already absolute and domain-checked. */
  gallery: string[];
  raw: unknown;
}

export interface GsParseResult {
  offers: GsOffer[];
  rejected: { index: number; reason: string }[];
  /**
   * Rows whose barcode no external catalog would accept (bad check digit,
   * impossible length, junk). The row is KEPT — the size still sells — but the
   * identifier is not written to the store, so this count is the only place
   * the supplier's data quality becomes visible before Merchant Center says so.
   */
  invalidBarcodes: number;
  /** Barcodes the feed gives to more than one SKU+size — a channel refuses both. */
  duplicateBarcodes: number;
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
    // Either field may be the populated one — the provider fills them
    // inconsistently, and an empty image_full_url used to mean no picture at
    // all even when `image` held the very same path.
    const image = resolveGsImage(row.image_full_url || row.image, row.image_name);
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
      image,
      gallery: resolveGsGallery(row.additional_images, image),
      raw: rawRow,
    };
    const key = `${offer.sku}::${offer.euNorm}`;
    const existing = byKey.get(key);
    if (!existing || (existing.quantity === 0 && offer.quantity > 0)) byKey.set(key, offer);
  });

  const offers = [...byKey.values()];
  const seen = new Set<string>();
  let invalidBarcodes = 0;
  const duplicated = new Set<string>();
  for (const o of offers) {
    if (!o.barcode) continue;
    const { gtin } = normalizeGtin(o.barcode);
    if (!gtin) {
      invalidBarcodes += 1;
      continue;
    }
    if (seen.has(gtin)) duplicated.add(gtin);
    seen.add(gtin);
  }
  return { offers, rejected, invalidBarcodes, duplicateBarcodes: duplicated.size };
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
  const title = first?.productName ?? "";
  const brand = first?.brandName ?? "";
  // The feed sends no taxonomy, so the family a pricing rule scopes to has to
  // come from the title — the same classifier the catalog sidebar is built
  // from. Without it a rule for "Yeezy → Foam RNNR" would skip exactly the
  // GS-owned products the operator sees filed under that family.
  const derived = classifyTitle(title, brand);
  return {
    stockxId: `gs:${skuKey(sku)}`,
    sku: skuKey(sku),
    title,
    brand,
    image: first?.image ?? "",
    ...(first?.gallery?.length ? { gallery: first.gallery } : {}),
    market,
    currency: "EUR",
    source: "goldensneakers",
    ...(derived
      ? {
          category: derived.category,
          secondaryCategory: derived.secondaryCategory,
          ...(derived.gender ? { gender: derived.gender } : {}),
        }
      : {}),
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
