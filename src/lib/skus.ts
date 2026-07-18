/** Split a free-text SKU blob on commas / whitespace / newlines, de-duplicated. */
export function parseSkus(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)));
}

/** Canonical SKU key — uppercased + trimmed so lookups are case-insensitive. */
export function skuKey(sku: string): string {
  return sku.trim().toUpperCase();
}

/** Plausible StockX style code: alphanumeric + dashes, 4-20 chars, ≥1 digit. */
const SKU_TOKEN = /^[A-Z0-9][A-Z0-9-]{3,19}$/i;

/**
 * Pull plausible SKUs out of arbitrary text (a pasted list, a CSV/TSV export):
 * split on separators, strip quotes, keep only style-code-shaped tokens with at
 * least one digit, de-duplicated. Forgiving on purpose — every candidate is
 * GET-verified against KicksDB before it can enter the catalog.
 */
export function extractSkus(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.trim().replace(/^["']+|["']+$/g, "");
    if (!token || !SKU_TOKEN.test(token)) continue;
    if (!/\d/.test(token)) continue;
    out.add(token);
  }
  return [...out];
}
