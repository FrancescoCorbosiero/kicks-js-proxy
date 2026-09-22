/**
 * True for a KicksDB 500 caused by a product's OWN data rather than an outage:
 * the API dies unmarshalling StockX's payload for that product (e.g. "json:
 * cannot unmarshal number -5 into Go struct field ...sell_faster of type
 * uint32"). Deterministic per SKU — retrying is pointless, but OTHER SKUs in
 * the same batch still fetch fine, so a failed batch carrying this signature
 * must be bisected, never aborted as an outage.
 *
 * Pure and framework-free so it can be unit-tested (client.ts is server-only).
 */
export function isPoisonedDataError(e: unknown): boolean {
  const he = e as { status?: number; body?: string; message?: string };
  if (he == null || he.status !== 500) return false;
  return /cannot unmarshal/i.test(he.body ?? he.message ?? "");
}

/**
 * True for the KicksDB 500 that means "I have none of these", not "I broke":
 *
 *   {"title":"Internal Server Error","status":500,"detail":"cannot load prices",
 *    "errors":[{"message":"rpc error: code = Unknown desc = no products found"}]}
 *
 * The bulk-prices endpoint raises this instead of returning an empty list when
 * NOTHING in the requested set is on StockX — a store full of feed-owned or
 * store-only products hits it constantly. Read as an outage it aborts the
 * whole sync ("KicksDB unreachable"); read correctly it is simply zero rows.
 *
 * Deterministic, so it is also pointless to retry: the same set will be just
 * as absent on the fourth attempt as on the first.
 */
export function isNoProductsFoundError(e: unknown): boolean {
  const he = e as { status?: number; body?: string; message?: string };
  if (he == null || he.status !== 500) return false;
  return /no products found/i.test(he.body ?? he.message ?? "");
}
