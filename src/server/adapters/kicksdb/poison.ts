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
