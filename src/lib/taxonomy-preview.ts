import { resolveCategoryPath, type TaxonomyConfig } from "@core/config";

/**
 * The "what would this do to my catalog" table, grouped and BOUNDED.
 *
 * Bounded is the whole point. The number of distinct categories a taxonomy
 * produces has no ceiling: trusting a source with its own tree, when that tree
 * is inferred per model, yields one category per product — which is exactly
 * the mistake this preview exists to reveal, so it has to survive revealing
 * it. Unbounded, a 4000-product feed answered one keystroke with 4000 rows.
 */

/** Preview rows returned. The totals beside them still cover everything. */
export const PREVIEW_LIMIT = 50;
/** Options offered by the scope pickers. Free text covers the rest. */
export const OPTION_LIMIT = 300;
/** Example products carried per row — enough to check the number at a glance. */
const SAMPLES_PER_ROW = 3;

/** The catalog columns the preview reads: no variants, no jsonb. */
export interface TaxonomyPreviewInput {
  sku: string;
  title: string;
  brand: string;
  source: string;
  category: string;
  secondaryCategory: string;
}

/** One line of the "what would this do" table. */
export interface TaxonomyPreviewRow {
  /** The resolved store category path, joined with " › ". Empty = none. */
  category: string;
  products: number;
  /** A few example products, so the number is checkable at a glance. */
  samples: { sku: string; title: string; source: string }[];
}

export interface TaxonomyPreview {
  /** Sources actually present in the catalog — no invented choices. */
  sources: { source: string; products: number }[];
  /** Brands present, for the rule scope pickers. */
  brands: string[];
  /** Catalog families, likewise. */
  categories: string[];
  preview: TaxonomyPreviewRow[];
  /** Distinct categories the draft produces, including the unlisted ones. */
  categoryCount: number;
  /** Catalog products considered by the preview. */
  total: number;
}

/** Resolve every catalog product against a taxonomy and group the results. */
export function buildTaxonomyPreview(
  rows: TaxonomyPreviewInput[],
  taxonomy: TaxonomyConfig,
): TaxonomyPreview {
  const byCategory = new Map<string, TaxonomyPreviewRow>();
  const bySource = new Map<string, number>();
  const brands = new Set<string>();
  const categories = new Set<string>();

  for (const row of rows) {
    const source = row.source || "kicksdb";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    if (row.brand) brands.add(row.brand);
    if (row.category) categories.add(row.category);

    const path = resolveCategoryPath(
      {
        sku: row.sku,
        title: row.title,
        brand: row.brand,
        source,
        category: row.category,
        secondaryCategory: row.secondaryCategory,
        model: "",
      },
      taxonomy,
    );
    const key = path.join(" › ");
    const entry = byCategory.get(key) ?? { category: key, products: 0, samples: [] };
    entry.products += 1;
    if (entry.samples.length < SAMPLES_PER_ROW) {
      entry.samples.push({ sku: row.sku, title: row.title, source });
    }
    byCategory.set(key, entry);
  }

  const preview = [...byCategory.values()].sort((a, b) => b.products - a.products);
  return {
    sources: [...bySource.entries()]
      .map(([source, products]) => ({ source, products }))
      .sort((a, b) => b.products - a.products),
    brands: [...brands].sort((a, b) => a.localeCompare(b)).slice(0, OPTION_LIMIT),
    categories: [...categories].sort((a, b) => a.localeCompare(b)).slice(0, OPTION_LIMIT),
    // Biggest first, so the truncated tail is always the long thin one.
    preview: preview.slice(0, PREVIEW_LIMIT),
    categoryCount: preview.length,
    total: rows.length,
  };
}
