import "server-only";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { getAnyBySkus } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { gsOwnedProducts } from "@/server/feeds/owner";
import type { StoreProductModel } from "@/server/store-json/model";
import { skuKey } from "@/lib/skus";
import { planPublish } from "./publish-plan";
import { buildIdentityResolver } from "./identity";
import { planRepair, type RepairField, type LiveProduct } from "./repair-plan";
import { getWooClient, type WooClient } from "./client";
import type { SourceProduct } from "@core/core-spine";

/**
 * Self-repair: put back what a product on the store is missing, from the
 * source that owns it.
 *
 * A supplier reshaped its image fields, a publish ran, and products landed
 * without pictures. The store was not wrong and the catalog was not wrong —
 * the two simply stopped agreeing, and nothing in this app could close the gap
 * except the force reimport, which deletes and re-creates every variation to
 * fix a photograph.
 *
 * The pass below is the opposite of that: it reads the live product, fills
 * only what is empty, and touches nothing else. It is additive, idempotent and
 * per-product isolated, which together mean it is safe to run on the whole
 * store, twice, at any time. Source-agnostic by construction — the product's
 * owner (supplier feed or catalog) is resolved exactly as the publisher does
 * it, so a new source inherits repair for free.
 */

export interface RepairProductReport {
  sku: string;
  title: string;
  storeProductId: number | null;
  /** Fields this run filled (or would fill, on a dry run). */
  filled: RepairField[];
  /** Missing on the store and not available from the source either. */
  unavailable: RepairField[];
  error: string | null;
}

export interface RepairOutcome {
  dryRun: boolean;
  products: RepairProductReport[];
  repaired: number; // products that needed (and got) at least one field
  alreadyWhole: number;
  failed: number;
  /** Identity taxonomies this store would not take — same meaning as publish. */
  identitySkipped: string[];
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/** The pa_taglia attribute id, resolved once (same helper the publisher uses). */
async function resolveTagliaId(client: WooClient): Promise<number | undefined> {
  try {
    const taxonomies = await client.getAttributeTaxonomies();
    return taxonomies.find((t) => t.slug.toLowerCase().includes("taglia"))?.id;
  } catch {
    return undefined;
  }
}

/** Every SKU the store carries that a source could still complete. */
export async function scanRepairCandidates(): Promise<{
  /** SKUs whose snapshot row already shows a gap — the cheap pre-filter. */
  incomplete: string[];
  /** SKUs on the store AND known to a source: everything repair could visit. */
  repairable: string[];
  hasSnapshot: boolean;
}> {
  const config = await getActiveConfig();
  const market = config.source.market;
  const snapshot = await getActiveSnapshot().catch(() => null);
  const products = snapshot?.products ?? [];
  const skus = [...new Set(products.map((p) => (p.sku ? skuKey(p.sku) : "")).filter(Boolean))];

  const [catalogEntries, owned] = await Promise.all([
    getAnyBySkus(market, skus).catch(() => new Map<string, SourceProduct>()),
    getOverrides()
      .catch(() => null)
      .then((o) => gsOwnedProducts(skus, market, o))
      .catch(() => new Map()),
  ]);
  const known = (sku: string) => owned.has(sku) || catalogEntries.has(sku);

  // The snapshot keeps the first image only, which is exactly the question
  // "does this product have a picture at all?" — no REST call needed to find
  // the candidates. Everything else is confirmed live, per product.
  const incomplete: string[] = [];
  for (const p of products as StoreProductModel[]) {
    const sku = p.sku ? skuKey(p.sku) : "";
    if (!sku || !known(sku)) continue;
    if (!Array.isArray(p.images) || p.images.length === 0) incomplete.push(sku);
  }
  return {
    incomplete: [...new Set(incomplete)],
    repairable: skus.filter(known),
    hasSnapshot: snapshot != null,
  };
}

/**
 * Repair the given SKUs. Dry-run computes the exact patch per product and
 * writes nothing; a live run PATCHes only the products that need it.
 */
export async function repairProducts(
  skus: string[],
  options: { dryRun: boolean; includeGallery?: boolean },
): Promise<RepairOutcome> {
  const config = await getActiveConfig();
  const market = config.source.market;
  const client = getWooClient();
  const overrides = await getOverrides().catch(() => null);

  const uniqueSkus = [...new Set(skus.map(skuKey))];
  const catalogEntries = await getAnyBySkus(market, uniqueSkus);
  // Ownership first, exactly as the publisher resolves it.
  const owned = await gsOwnedProducts(uniqueSkus, market, overrides);
  const catalogFor = (sku: string): SourceProduct | undefined =>
    owned.get(sku)?.product ?? catalogEntries.get(sku);

  const tagliaAttributeId = await resolveTagliaId(client);
  const identity = await buildIdentityResolver(
    client,
    uniqueSkus.map(catalogFor).filter((c): c is SourceProduct => c != null),
  ).catch(() => null);

  const reports: RepairProductReport[] = [];
  let repaired = 0;
  let alreadyWhole = 0;

  await forEachLimit(uniqueSkus, 3, async (sku) => {
    const report: RepairProductReport = {
      sku,
      title: sku,
      storeProductId: null,
      filled: [],
      unavailable: [],
      error: null,
    };
    reports.push(report);

    try {
      const catalog = catalogFor(sku);
      if (!catalog) {
        report.error = "no source covers this SKU — nothing to repair from";
        return;
      }
      report.title = catalog.title || sku;

      const found = await client.findProductsBySku(sku);
      const onStore = found[0] ?? null;
      if (!onStore) {
        report.error = "not on the store — publish it instead";
        return;
      }
      report.storeProductId = onStore.id;

      // The publisher's own planner decides what the pictures ARE, so a repair
      // can never disagree with a fresh publish about the same product.
      const plan = planPublish({
        catalog,
        config,
        tagliaAttributeId,
        identity: identity?.for(catalog),
        includeGallery: options.includeGallery,
      });

      // Live, never the snapshot: the snapshot knows only the first image and
      // nothing about brands or categories, and a patch is a write.
      const live = (await client.getFullProduct(onStore.id)) as unknown as LiveProduct;
      const patch = planRepair(live, {
        images: plan.images,
        identity: identity?.for(catalog),
        wantsGender: !!(catalog.gender ?? "").trim(),
      });

      report.filled = patch.fills;
      report.unavailable = patch.unavailable;
      if (patch.fills.length === 0) {
        alreadyWhole += 1;
        return;
      }
      if (!options.dryRun) await client.updateProduct(onStore.id, patch.body);
      repaired += 1;
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  });

  return {
    dryRun: options.dryRun,
    products: reports.sort((a, b) => a.sku.localeCompare(b.sku)),
    repaired,
    alreadyWhole,
    failed: reports.filter((r) => r.error != null).length,
    identitySkipped: identity?.skipped ?? [],
  };
}
