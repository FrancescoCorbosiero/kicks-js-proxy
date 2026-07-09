/** One entry in the discoverable KicksDB catalog: a fetchable SKU + its labels. */
export interface CatalogItem {
  sku: string;
  title: string;
  brand: string;
}

/**
 * Case-insensitive substring filter over SKU / title / brand. An empty query
 * returns the list unchanged. Pure — used by the catalog discovery panel.
 */
export function filterCatalog(items: CatalogItem[], query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (i) =>
      i.sku.toLowerCase().includes(q) ||
      i.title.toLowerCase().includes(q) ||
      i.brand.toLowerCase().includes(q),
  );
}
