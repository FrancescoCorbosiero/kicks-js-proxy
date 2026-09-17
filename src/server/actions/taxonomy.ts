"use server";

import { z } from "zod";
import type { TaxonomyConfig } from "@core/config";
import { getActiveConfig, saveActiveConfig } from "@/server/config/repo";
import { DEFAULT_TAXONOMY } from "@/server/config/defaults";
import { listPublishCandidates } from "@/server/catalog/repo";
import { buildTaxonomyPreview, type TaxonomyPreview } from "@/lib/taxonomy-preview";

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

export type { TaxonomyPreviewRow } from "@/lib/taxonomy-preview";

export interface TaxonomyState extends TaxonomyPreview {
  taxonomy: TaxonomyConfig;
}

/**
 * Resolve every catalog product against a taxonomy and group the results.
 * Reads the light catalog columns only — no variants, no jsonb — so the
 * preview is cheap enough to recompute on every edit, and comes back bounded
 * so the browser can render the answer however bad the answer is.
 */
async function computeState(taxonomy: TaxonomyConfig): Promise<TaxonomyState> {
  const config = await getActiveConfig();
  const rows = await listPublishCandidates(config.source.market).catch(() => []);
  return { taxonomy, ...buildTaxonomyPreview(rows, taxonomy) };
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
