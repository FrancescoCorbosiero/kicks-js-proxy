import "server-only";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";
import { getAnyBySkus, listPublishCandidates, type PublishCandidate } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { manualPriceFor } from "@/server/overrides/model";
import { gsOwnedProducts } from "@/server/feeds/owner";
import { sourceEuSize } from "@/server/store-json/match";
import type { StoreProductModel, StoreVariation } from "@/server/store-json/model";
import { skuKey } from "@/lib/skus";
import { planPublish, planReimportParent, type PublishPlan } from "./publish-plan";
import { getWooClient, type WooClient } from "./client";

/**
 * The Publisher — the app's first WRITE path that creates store data instead
 * of adjusting it.
 *
 * Everything else here is a re-pricer: the sync walks the store snapshot, so a
 * catalog product the store has never carried is unreachable by design (its
 * plan rows come out as "create", which the apply drops). A supplier feed
 * brings exactly those products. They become first-class in the catalog —
 * card, drawer, family margin rules — and completely invisible to customers.
 *
 * Same safety posture as every other write path: dry-run first, per-product
 * failure isolation, one audit row per run, snapshot patched afterwards. Plus
 * one rule unique to creation — a live SKU lookup immediately before every
 * create, because inventing a duplicate parent is the one mistake that cannot
 * be undone by running the tool again.
 */

export type PublishAction = "create" | "reimport" | "skip";

/**
 * Why a product was left alone. A CODE, not a sentence: these are shown to a
 * non-technical operator in their own language, so the wording belongs in the
 * dictionaries, not in the executor.
 */
export type PublishSkipReason = "alreadyOnStore" | "feedDelisted";

export interface PublishProductReport {
  sku: string;
  title: string;
  action: PublishAction;
  storeProductId: number | null;
  permalink: string | null;
  /** Canonical sizes created for this product. */
  sizes: string[];
  /** Sizes created with no price at all (no ask, no lock). */
  unpricedSizes: string[];
  /** Catalog variants with no resolvable EU size. */
  skippedNoEu: number;
  images: number;
  reason: PublishSkipReason | null;
  error: string | null;
}

export interface PublishOutcome {
  auditId: string;
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: PublishProductReport[];
  created: number; // parent products created
  reimported: number; // existing parents refreshed
  variations: number; // variations created
  skipped: number;
  failed: number;
}

export interface PublishOptions {
  dryRun: boolean;
  /** Sideload the extra product shots too, not just the main image. */
  includeGallery?: boolean;
  /**
   * Act on SKUs the store ALREADY has: refresh the parent's name/attributes
   * and rebuild the whole variation set from the catalog. Without it those
   * SKUs are skipped untouched.
   */
  force?: boolean;
  /** On a force reimport, re-sideload the images (off = keep the store's). */
  replaceMedia?: boolean;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * The pa_taglia GLOBAL attribute id. Resolved once, before any product is
 * planned — never lazily inside the concurrent workers, where a "have I
 * fetched yet?" flag is set before the await and the other workers read the
 * id back as undefined. Binding by name instead of id makes Woo attach a
 * LOCAL attribute of the same name, whose options are not the taxonomy's
 * terms: the variations exist but the storefront's size selector cannot
 * resolve them.
 */
async function resolveTagliaId(client: WooClient): Promise<number | undefined> {
  try {
    const taxonomies = await client.getAttributeTaxonomies();
    return taxonomies.find((t) => t.slug.toLowerCase().includes("taglia"))?.id;
  } catch {
    return undefined; // name-binding fallback still works
  }
}

/** A catalog product the Publish tab can act on, and whether the store has it. */
export type PublishTarget = PublishCandidate & { onStore: boolean };

/**
 * Every catalog product the Publisher can act on, flagged with whether the
 * store already has it. The tab defaults to the ones it does NOT — that is
 * the gap the feature exists to close — but the on-store ones stay reachable,
 * because otherwise "force reimport" would have nothing to point at.
 *
 * Store presence comes from the snapshot — the same source every other tab
 * reads — so a stale snapshot only ever mislabels a product as missing. The
 * live per-SKU check at publish time is what keeps that from creating a
 * duplicate parent.
 */
export async function listPublishTargets(): Promise<{
  candidates: PublishTarget[];
  hasSnapshot: boolean;
}> {
  const config = await getActiveConfig();
  const snapshot = await getActiveSnapshot().catch(() => null);
  const storeSkus = new Set(
    (snapshot?.products ?? [])
      .map((p: StoreProductModel) => (p.sku ? skuKey(p.sku) : ""))
      .filter(Boolean),
  );
  const rows = await listPublishCandidates(config.source.market);
  return {
    candidates: rows.map((r) => ({ ...r, onStore: storeSkus.has(r.sku) })),
    hasSnapshot: snapshot != null,
  };
}

/**
 * Publish a set of catalog SKUs to the store. Each product is independent:
 * one failure never blocks the rest, and a product that fails mid-way is
 * reported with its parent id so it can be finished or removed by hand.
 */
export async function publishProducts(
  skus: string[],
  options: PublishOptions,
): Promise<PublishOutcome> {
  const { dryRun } = options;
  const config = await getActiveConfig();
  const market = config.source.market;
  const client = getWooClient();
  const snapshot = await getActiveSnapshot().catch(() => null);
  const overrides = await getOverrides().catch(() => null);

  const uniqueSkus = [...new Set(skus.map(skuKey))];
  const catalogEntries = await getAnyBySkus(market, uniqueSkus);
  // Product-level ownership: a GS-owned SKU publishes the FEED's variant set
  // (real sizes, real stock, presented prices), exactly like the rebuild.
  const gsOwned = await gsOwnedProducts(uniqueSkus, market, overrides);

  const reports: PublishProductReport[] = [];
  const published: { plan: PublishPlan; product: StoreProductModel }[] = [];
  const tagliaAttributeId = await resolveTagliaId(client);
  let created = 0;
  let reimported = 0;
  let variations = 0;

  await forEachLimit(uniqueSkus, 3, async (sku) => {
    const report: PublishProductReport = {
      sku,
      title: sku,
      action: "skip",
      storeProductId: null,
      permalink: null,
      sizes: [],
      unpricedSizes: [],
      skippedNoEu: 0,
      images: 0,
      reason: null,
      error: null,
    };
    reports.push(report);

    try {
      const gs = gsOwned.get(sku);
      const catalog = gs?.product ?? catalogEntries.get(sku);
      if (!catalog) {
        report.error = "not in the catalog nor the GoldenSneakers feed";
        return;
      }
      report.title = catalog.title || sku;

      // A feed product with no LIVE feed coverage has no stock truth left:
      // the supplier delisted it, and the catalog row is the last thing we
      // saw. Publishing it now would put a product the supplier no longer
      // sells on the shelf as unlimited sell-on-demand, at a stale price.
      if ((catalog.source ?? "kicksdb") !== "kicksdb" && !gs) {
        report.reason = "feedDelisted";
        return;
      }

      // Operator locks keyed by canonical EU size.
      const manualPrices: Record<string, number> = {};
      if (overrides) {
        for (const v of catalog.variants) {
          const eu = sourceEuSize(v);
          if (!eu) continue;
          const locked = manualPriceFor(overrides, catalog.sku, eu);
          if (locked != null) manualPrices[eu] = locked;
        }
      }

      const plan = planPublish({
        catalog,
        config,
        manualPrices,
        tagliaAttributeId,
        stockBySize: gs?.stockBySize,
        includeGallery: options.includeGallery,
      });
      report.sizes = plan.variations.map((v) => v.sizeLabel);
      report.unpricedSizes = plan.unpricedSizes;
      report.skippedNoEu = plan.skippedNoEu;
      report.images = plan.images.length;

      if (plan.variations.length === 0) {
        report.error = "no EU-sized variants to create";
        return;
      }

      // LIVE presence check — never the snapshot. Creating a second parent for
      // a SKU the store already has is the one unrecoverable mistake here.
      const existing = await client.findProductsBySku(sku);
      const onStore = existing[0] ?? null;

      if (onStore && !options.force) {
        report.action = "skip";
        report.storeProductId = onStore.id;
        report.reason = "alreadyOnStore";
        return;
      }

      report.action = onStore ? "reimport" : "create";
      if (dryRun) {
        report.storeProductId = onStore?.id ?? null;
        return;
      }

      let productId: number;
      if (onStore) {
        // Refresh identity + option list, then replace the variation set.
        productId = onStore.id;
        await client.updateProduct(
          productId,
          planReimportParent(plan, { replaceMedia: options.replaceMedia ?? false }),
        );
        const old = await client.getAllVariations(productId);
        const res = await client.batchVariations(productId, {
          delete: old.map((v) => v.id),
          create: plan.variations.map((v) => v.payload),
        });
        variations += res.create.filter((r) => r.error == null).length;
        const failedRows = res.create.filter((r) => r.error != null);
        if (failedRows.length > 0) {
          report.error = `${failedRows.length}/${plan.variations.length} variations failed: ${failedRows[0].error?.message ?? "unknown"}`;
        }
        reimported += 1;
      } else {
        const parent = await client.createProduct(plan.parentBody);
        productId = parent.id;
        report.permalink = parent.permalink ?? null;
        const res = await client.batchVariations(productId, {
          create: plan.variations.map((v) => v.payload),
        });
        variations += res.create.filter((r) => r.error == null).length;
        const failedRows = res.create.filter((r) => r.error != null);
        if (failedRows.length > 0) {
          // The parent EXISTS now — say so, so it can be finished or removed
          // rather than silently leaving a product with no sizes on sale.
          report.error = `parent created (#${productId}) but ${failedRows.length}/${plan.variations.length} variations failed: ${failedRows[0].error?.message ?? "unknown"}`;
        }
        created += 1;
      }
      report.storeProductId = productId;

      published.push({
        plan,
        product: {
          id: productId,
          sku,
          name: plan.title,
          attributes: (plan.parentBody as { attributes: unknown[] }).attributes,
          variations: plan.variations.map((v) => ({
            id: 0,
            sku: v.sku,
            regular_price: v.price != null ? v.price.toFixed(2) : null,
            sale_price: null,
            global_unique_id: v.upc,
            stock_quantity: null,
            manage_stock: false,
            stock_status: "instock",
            attributes: [{ name: "pa_taglia", option: v.sizeLabel }],
          })) as StoreVariation[],
        } as StoreProductModel,
      });
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  });

  // Patch the snapshot so a published product immediately counts as "on the
  // store" — it must not be offered for publishing again on the next render.
  if (!dryRun && published.length > 0 && snapshot) {
    try {
      const bySku = new Map(published.map((p) => [skuKey(p.plan.sku), p]));
      const seen = new Set<string>();
      snapshot.products = snapshot.products.map((p: StoreProductModel) => {
        const key = p.sku ? skuKey(p.sku) : "";
        const hit = key ? bySku.get(key) : undefined;
        if (!hit) return p;
        seen.add(key);
        return hit.product;
      });
      for (const [key, hit] of bySku) {
        if (!seen.has(key)) snapshot.products.push(hit.product);
      }
      const info = await getSnapshotInfo();
      await saveSnapshot(snapshot, info?.source ?? "rest");
    } catch (e) {
      console.warn("[publish] snapshot patch skipped:", e instanceof Error ? e.message : String(e));
    }
  }

  const failed = reports.filter((r) => r.error != null).length;
  const skipped = reports.filter((r) => r.action === "skip" && r.error == null).length;
  const acted = created + reimported;
  const status: ApplyAuditRow["status"] = dryRun
    ? "dry_run"
    : failed === 0
      ? "applied"
      : acted > 0
        ? "partial"
        : "failed";

  const [row] = await db
    .insert(applyAudit)
    .values({
      status,
      dryRun,
      updatedCount: variations,
      failed: reports
        .filter((r) => r.error != null)
        .map((r) => ({ stockxVariantId: `publish:${r.sku}`, error: r.error! })),
      result: {
        kind: "publish",
        products: reports.length,
        created,
        reimported,
        variations,
        skipped,
        failedProducts: failed,
      },
      finishedAt: new Date(),
    })
    .returning({ id: applyAudit.id });

  return {
    auditId: row.id,
    dryRun,
    status,
    products: reports,
    created,
    reimported,
    variations,
    skipped,
    failed,
  };
}
