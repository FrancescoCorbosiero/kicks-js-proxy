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

/* ------------------------------------------------------------------ */
/* Discovery facets — bounded, because the catalog is not              */
/* ------------------------------------------------------------------ */

/**
 * Bounds on the sidebar tree. The categories come from the catalog's own
 * metadata, which has no ceiling: a source with no real taxonomy — a supplier
 * feed whose tree is inferred from product titles — produces one category PER
 * PRODUCT, and the tree is rendered TWICE (sidebar + mobile chips). Unbounded,
 * a 4000-product feed shipped a 5 MB page and ~25 000 DOM nodes on the tab the
 * operator lives in. Biggest first, so what gets cut is the long thin tail.
 */
export const CATEGORY_LIMIT = 60;
/** Sub-categories unfolded under the active category. Same reason. */
export const SUBCATEGORY_LIMIT = 40;

export interface CategoryCountRow {
  category: string; // "" = uncategorized (no metadata yet)
  secondaryCategory: string; // "" = none
  count: number;
}

/** The sidebar tree: category -> sub-category counts, Uncategorized last. */
export interface CategoryNode {
  category: string; // "" = uncategorized
  count: number;
  children: { name: string; count: number }[];
}

/**
 * Group the per-(category, sub-category) counts into the sidebar tree, bounded.
 *
 * `activeCategory` is whatever the URL selects: it is kept whatever its size,
 * so the current filter always has a row to show as selected — and a way back
 * out. `hidden` is how many named categories the tree is not showing.
 */
export function buildCategoryTree(
  rows: CategoryCountRow[],
  activeCategory?: string,
): { nodes: CategoryNode[]; hidden: number } {
  const byCat = new Map<string, CategoryNode>();
  for (const r of rows) {
    const node = byCat.get(r.category) ?? { category: r.category, count: 0, children: [] };
    node.count += r.count;
    if (r.secondaryCategory !== "") {
      node.children.push({ name: r.secondaryCategory, count: r.count });
    }
    byCat.set(r.category, node);
  }
  for (const node of byCat.values()) {
    node.children.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    node.children = node.children.slice(0, SUBCATEGORY_LIMIT);
  }
  const nodes = [...byCat.values()];
  const named = nodes
    .filter((n) => n.category !== "")
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const kept = named.slice(0, CATEGORY_LIMIT);
  if (activeCategory && !kept.some((n) => n.category === activeCategory)) {
    const active = named.find((n) => n.category === activeCategory);
    if (active) kept.push(active);
  }
  const uncategorized = nodes.find((n) => n.category === "");
  return {
    nodes: uncategorized ? [...kept, uncategorized] : kept,
    hidden: Math.max(0, named.length - kept.length),
  };
}
