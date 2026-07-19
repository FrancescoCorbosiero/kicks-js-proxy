/**
 * Build a query string from a params record, dropping empty/undefined values —
 * the discovery pages keep all filter state in the URL (shareable, back-button
 * friendly), so links are built by merging partial updates over current params.
 */
export type QueryParams = Record<string, string | number | undefined | null>;

export function buildQuery(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/** Merge partial updates over current params (undefined removes a key). */
export function mergeQuery(current: QueryParams, updates: QueryParams): string {
  return buildQuery({ ...current, ...updates });
}
