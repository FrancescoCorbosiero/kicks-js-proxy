/** Split a free-text SKU blob on commas / whitespace / newlines, de-duplicated. */
export function parseSkus(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)));
}

/** Canonical SKU key — uppercased + trimmed so lookups are case-insensitive. */
export function skuKey(sku: string): string {
  return sku.trim().toUpperCase();
}
