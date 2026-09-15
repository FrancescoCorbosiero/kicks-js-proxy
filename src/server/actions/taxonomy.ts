"use server";

import { z } from "zod";
import { resolveCategoryPath, type TaxonomyConfig } from "@core/config";
import { getActiveConfig, saveActiveConfig } from "@/server/config/repo";
import { DEFAULT_TAXONOMY } from "@/server/config/defaults";
import { listPublishCandidates } from "@/server/catalog/repo";

/**
 * The Taxonomies tab's server half: read the configuration, save it, and —
 * the part that makes it trustworthy — show what it would actually do to the
 * catalog the shop really has, before a single product is written.
 */

const RuleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  scope: z.object({
    source: z.string().optional(),
    brand: z.string().optional(),
    category: z.string().optional(),
    secondaryCategory: z.string().optional(),
    model: z.string().optional(),
    sku: z.string().optional(),
  }),
  category: z.string().max(200),
});

const TaxonomySchema = z.object({
  useSourceTree: z.array(z.string().min(1)).max(20),
  defaultCategory: z.string().max(200),
  rules: z.array(RuleSchema).max(200),
  write: z.object({
    brandTaxonomy: z.boolean(),
    brandAttribute: z.boolean(),
    genderAttribute: z.boolean(),
  }),
});

/** One line of the "what would this do" table. */
export interface TaxonomyPreviewRow {
  /** The resolved store category path, joined with " › ". Empty = none. */
  category: string;
  products: number;
  /** A few example products, so the number is checkable at a glance. */
  samples: { sku: string; title: string; source: string }[];
}

export interface TaxonomyState {
  taxonomy: TaxonomyConfig;
  /** Sources actually present in the catalog — no invented choices. */
  sources: { source: string; products: number }[];
  /** Brands present, for the rule scope pickers. */
  brands: string[];
  /** Catalog families, likewise. */
  categories: string[];
  preview: TaxonomyPreviewRow[];
  /** Catalog products considered by the preview. */
  total: number;
}

/**
 * Resolve every catalog product against a taxonomy and group the results.
 * Reads the light catalog columns only — no variants, no jsonb — so the
 * preview is cheap enough to recompute on every edit.
 */
async function computeState(taxonomy: TaxonomyConfig): Promise<TaxonomyState> {
  const config = await getActiveConfig();
  const rows = await listPublishCandidates(config.source.market).catch(() => []);

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
    if (entry.samples.length < 3) {
      entry.samples.push({ sku: row.sku, title: row.title, source });
    }
    byCategory.set(key, entry);
  }

  return {
    taxonomy,
    sources: [...bySource.entries()]
      .map(([source, products]) => ({ source, products }))
      .sort((a, b) => b.products - a.products),
    brands: [...brands].sort((a, b) => a.localeCompare(b)),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
    preview: [...byCategory.values()].sort((a, b) => b.products - a.products),
    total: rows.length,
  };
}

/** The tab's initial state: the saved configuration and what it does today. */
export async function getTaxonomyState(): Promise<TaxonomyState> {
  const config = await getActiveConfig();
  return computeState(config.taxonomy);
}

/**
 * Recompute the preview for an UNSAVED draft — the whole point of the tab:
 * see the effect of a rule before committing it.
 */
export async function previewTaxonomy(
  input: unknown,
): Promise<{ ok: boolean; error?: string; state?: TaxonomyState }> {
  const parsed = TaxonomySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  try {
    return { ok: true, state: await computeState(parsed.data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveTaxonomy(
  input: unknown,
): Promise<{ ok: boolean; error?: string; state?: TaxonomyState }> {
  const parsed = TaxonomySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  try {
    const config = await getActiveConfig();
    await saveActiveConfig({ ...config, taxonomy: parsed.data });
    return { ok: true, state: await computeState(parsed.data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Put back the shipped defaults, leaving every other setting alone. */
export async function resetTaxonomy(): Promise<{ ok: boolean; error?: string; state?: TaxonomyState }> {
  try {
    const config = await getActiveConfig();
    await saveActiveConfig({ ...config, taxonomy: DEFAULT_TAXONOMY });
    return { ok: true, state: await computeState(DEFAULT_TAXONOMY) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
