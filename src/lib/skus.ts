/** Split a free-text SKU blob on commas / whitespace / newlines, de-duplicated. */
export function parseSkus(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)));
}
