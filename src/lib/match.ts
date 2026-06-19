/**
 * Whether a fetched product is the one the operator searched for: an exact SKU
 * or title match, or a title that contains the full query phrase. Used to
 * highlight the intended record among fuzzy query results.
 */
export function isExactMatch(term: string, sku: string, title: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  const s = sku.trim().toLowerCase();
  const ti = title.trim().toLowerCase();
  return s === t || ti === t || ti.includes(t);
}
