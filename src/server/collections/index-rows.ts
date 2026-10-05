import { attributeKey, type IndexedProduct, type IndexedTerm } from "@core/collections";
import type { WooIndexProduct } from "@/server/woo/client";

/**
 * A store product as the automatic categories keep it (the store_index row):
 * what a rule reads, plus what the runs need around it — the type, the link,
 * and the store's own last-modified time, which is where the next check for
 * changes starts.
 */
export interface IndexRow extends IndexedProduct {
  type: string;
  permalink: string;
  /** The store's last-modified time (ISO, UTC), null when it sent none. */
  dateModified: string | null;
}

/**
 * WooCommerce's *_gmt dates come without a zone ("2026-10-05T12:00:00"):
 * they are UTC, and Date.parse would read them as local time. Unknown
 * values (a draft has no publication date yet) come back as null.
 */
export function gmtToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const zoned = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * WordPress stores names HTML-escaped ("Saldi &amp; Outlet", "Air Force 1
 * &#8211; White") and the REST API hands them over as stored. Decoded once,
 * here, so every list and every log line reads like the shop's own pages.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

function terms(list: WooIndexProduct["categories"]): IndexedTerm[] {
  return (list ?? []).map((t) => ({ id: t.id, slug: t.slug, name: decodeEntities(t.name) }));
}

/** The store's answer (a listing row or a batch row), as an index row. */
export function toIndexRow(p: WooIndexProduct): IndexRow {
  const price = typeof p.price === "number" ? p.price : Number.parseFloat(p.price ?? "");
  return {
    id: p.id,
    sku: p.sku ?? "",
    name: decodeEntities(p.name ?? ""),
    type: p.type ?? "",
    status: p.status ?? "",
    permalink: p.permalink ?? "",
    categories: terms(p.categories),
    tags: terms(p.tags),
    brands: terms(p.brands),
    attributes: (p.attributes ?? []).map((a) => ({
      key: attributeKey(a.id, a.name ?? ""),
      name: decodeEntities(a.name ?? ""),
      options: (a.options ?? []).map((o) => decodeEntities(String(o))),
    })),
    price: Number.isFinite(price) ? price : null,
    onSale: p.on_sale ?? false,
    stockStatus: p.stock_status ?? "",
    dateCreated: gmtToIso(p.date_created_gmt),
    dateModified: gmtToIso(p.date_modified_gmt),
  };
}

/** term id → parent id, from a taxonomy listing (parents absent = top level). */
export function parentsOf(list: { id: number; parent?: number }[]): Map<number, number> {
  return new Map(list.map((t) => [t.id, t.parent ?? 0]));
}
