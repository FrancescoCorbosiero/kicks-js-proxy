import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";
import { getAnyBySkus } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { manualPriceFor } from "@/server/overrides/model";
import { gsOwnedProducts } from "@/server/feeds/owner";
import {
  planRebuild,
  rebuildParentAttributes,
  type RebuildPlan,
} from "@/server/store-json/rebuild-plan";
import { sourceEuSize } from "@/server/store-json/match";
import type { StoreProductModel, StoreVariation } from "@/server/store-json/model";
import { skuKey } from "@/lib/skus";
import { getWooClient, type WooClient } from "./client";

/**
 * The Rebuild executor — the sledgehammer for products too inconsistent to
 * patch: DELETE every variation and re-CREATE the canonical set from the
 * KicksDB catalog, under the untouched parent (which keeps its id, slug,
 * SEO, media, taxonomies and swatch config). The parent's pa_taglia attribute
 * is reconstructed even when it is an empty stub — the known breakage that
 * hides every variant from the storefront.
 *
 * Same safety posture as the sync apply: dry-run first, per-product failure
 * isolation, every run audited, and the stored snapshot patched to the
 * post-rebuild state for products that fully succeeded.
 */

export interface RebuildProductReport {
  sku: string;
  storeProductId: number | null;
  oldCount: number;
  newSizes: string[]; // canonical sizes being created
  droppedOldSizes: string[]; // old sizes with no catalog twin — extras lost
  unpricedSizes: string[];
  carried: number; // variations whose extras were carried over
  error: string | null;
}

export interface RebuildOutcome {
  auditId: string;
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: RebuildProductReport[];
  created: number;
  deleted: number;
  failedProducts: number;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/** Resolve the pa_taglia global-attribute id: from the parent, else the registry. */
async function resolveTagliaId(
  client: WooClient,
  parentAttributes: unknown,
  cache: { id?: number; fetched: boolean },
): Promise<number | undefined> {
  if (Array.isArray(parentAttributes)) {
    for (const el of parentAttributes) {
      const o = el as Record<string, unknown>;
      if (o && typeof o === "object" && String(o.name ?? o.slug ?? "").toLowerCase().includes("taglia")) {
        if (typeof o.id === "number" && o.id > 0) return o.id;
      }
    }
  }
  if (!cache.fetched) {
    cache.fetched = true;
    try {
      const taxonomies = await client.getAttributeTaxonomies();
      cache.id = taxonomies.find((t) => t.slug.toLowerCase().includes("taglia"))?.id;
    } catch {
      cache.id = undefined; // name-binding fallback still works
    }
  }
  return cache.id;
}

/**
 * Rebuild a set of products. `auditId` accumulates a chunked bulk run into one
 * history row: the first chunk creates it, later chunks add their counts —
 * the whole-catalog rebuild is one line in the log, not hundreds.
 */
export async function rebuildProducts(
  skus: string[],
  dryRun: boolean,
  auditId?: string,
): Promise<RebuildOutcome> {
  const config = await getActiveConfig();
  const market = config.source.market;
  const client = getWooClient();
  const snapshot = await getActiveSnapshot();
  const overrides = await getOverrides().catch(() => null);
  const catalogEntries = await getAnyBySkus(market, skus);
  // Product-level ownership: GS-owned SKUs rebuild from the feed's variant
  // set (real stock, presented prices) instead of the KicksDB catalog.
  const gsOwned = await gsOwnedProducts(skus, market, overrides);

  // Store product ids come from the snapshot (the pull) — SKU-matched.
  const productIdBySku = new Map<string, number>();
  for (const p of snapshot?.products ?? []) {
    if (p.sku) productIdBySku.set(skuKey(p.sku), p.id);
  }

  const reports: RebuildProductReport[] = [];
  const executed: { plan: RebuildPlan; created: StoreVariation[]; parentAttributes: unknown }[] = [];
  const tagliaCache: { id?: number; fetched: boolean } = { fetched: false };
  let created = 0;
  let deleted = 0;

  const uniqueSkus = [...new Set(skus.map(skuKey))];

  await forEachLimit(uniqueSkus, 3, async (sku) => {
    const report: RebuildProductReport = {
      sku,
      storeProductId: null,
      oldCount: 0,
      newSizes: [],
      droppedOldSizes: [],
      unpricedSizes: [],
      carried: 0,
      error: null,
    };
    reports.push(report);

    try {
      const gs = gsOwned.get(sku);
      const catalog = gs?.product ?? catalogEntries.get(sku);
      if (!catalog) {
        report.error = "not in the KicksDB catalog nor the GoldenSneakers feed";
        return;
      }
      const productId = productIdBySku.get(sku);
      if (productId == null) {
        report.error = "not in the store snapshot — run a pull first";
        return;
      }
      report.storeProductId = productId;

      // Fresh full payloads — the trimmed snapshot lacks meta_data by design.
      const [fullParent, oldVariations] = await Promise.all([
        client.getFullProduct(productId),
        client.getAllVariations(productId),
      ]);
      report.oldCount = oldVariations.length;

      const tagliaAttributeId = await resolveTagliaId(client, fullParent.attributes, tagliaCache);

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

      const plan = planRebuild({
        parentSku: sku,
        storeProductId: productId,
        catalog,
        oldVariations: oldVariations as StoreVariation[],
        config,
        manualPrices,
        tagliaAttributeId,
        stockBySize: gs?.stockBySize,
      });

      report.newSizes = plan.create.map((c) => c.sizeLabel);
      report.droppedOldSizes = plan.droppedOldSizes;
      report.unpricedSizes = plan.unpricedSizes;
      report.carried = plan.carriedCount;

      if (plan.create.length === 0) {
        report.error = "catalog has no EU-sized variants — nothing to create";
        return;
      }
      if (dryRun) return;

      // 1. Parent first: reconstruct pa_taglia (options must exist before the
      //    variations that reference them), everything else untouched.
      await client.updateProduct(productId, {
        attributes: rebuildParentAttributes(
          fullParent.attributes,
          plan.parentSizeOptions,
          tagliaAttributeId,
        ),
      });

      // 2. One batch: delete the entire old set, create the canonical one.
      const res = await client.batchVariations(productId, {
        delete: plan.deleteVariationIds,
        create: plan.create.map((c) => c.payload),
      });

      const failedRows = res.create.filter((r) => r.error != null);
      if (failedRows.length > 0) {
        report.error = `${failedRows.length}/${plan.create.length} variations failed: ${failedRows[0].error?.message ?? "unknown"}`;
      }
      const createdRows = res.create.filter((r) => r.error == null && r.id != null);
      created += createdRows.length;
      deleted += plan.deleteVariationIds.length;

      // Trimmed post-rebuild variations for the snapshot patch.
      const newVariations: StoreVariation[] = plan.create.map((c, i) => ({
        id: res.create[i]?.id ?? 0,
        sku: c.sku,
        regular_price: c.price != null ? c.price.toFixed(2) : null,
        sale_price: null,
        global_unique_id: c.upc,
        stock_quantity: null,
        manage_stock: false,
        stock_status: "instock",
        attributes: [{ name: "pa_taglia", option: c.sizeLabel }],
      }));
      executed.push({
        plan,
        created: newVariations.filter((v) => v.id !== 0),
        parentAttributes: rebuildParentAttributes(
          fullParent.attributes,
          plan.parentSizeOptions,
          tagliaAttributeId,
        ),
      });
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  });

  // Patch the snapshot to the post-rebuild state of fully-succeeded products.
  if (!dryRun && executed.length > 0 && snapshot) {
    try {
      const bySku = new Map(executed.map((e) => [skuKey(e.plan.sku), e]));
      snapshot.products = snapshot.products.map((p: StoreProductModel) => {
        const e = p.sku ? bySku.get(skuKey(p.sku)) : undefined;
        if (!e) return p;
        return { ...p, attributes: e.parentAttributes, variations: e.created };
      });
      const info = await getSnapshotInfo();
      await saveSnapshot(snapshot, info?.source ?? "rest");
    } catch (e) {
      console.warn("[rebuild] snapshot patch skipped:", e instanceof Error ? e.message : String(e));
    }
  }

  const failedProducts = reports.filter((r) => r.error != null).length;
  const failures = reports
    .filter((r) => r.error != null)
    .map((r) => ({ stockxVariantId: `rebuild:${r.sku}`, error: r.error! }));

  let finalAuditId: string;
  let status: ApplyAuditRow["status"];

  if (auditId) {
    // Accumulate this chunk into the bulk run's single row.
    const prevRows = await db.select().from(applyAudit).where(eq(applyAudit.id, auditId)).limit(1);
    const prev = prevRows[0];
    const prevResult = (prev?.result ?? {}) as Record<string, number>;
    const prevFailed = Array.isArray(prev?.failed) ? prev.failed : [];
    const totals = {
      kind: "rebuild",
      products: (prevResult.products ?? 0) + reports.length,
      created: (prevResult.created ?? 0) + created,
      deleted: (prevResult.deleted ?? 0) + deleted,
      failedProducts: (prevResult.failedProducts ?? 0) + failedProducts,
    };
    status = dryRun
      ? "dry_run"
      : totals.failedProducts === 0
        ? "applied"
        : totals.failedProducts < totals.products
          ? "partial"
          : "failed";
    await db
      .update(applyAudit)
      .set({
        status,
        updatedCount: (prev?.updatedCount ?? 0) + created,
        failed: [...prevFailed, ...failures],
        result: totals,
        finishedAt: new Date(),
      })
      .where(eq(applyAudit.id, auditId));
    finalAuditId = auditId;
  } else {
    status = dryRun
      ? "dry_run"
      : failedProducts === 0
        ? "applied"
        : failedProducts < reports.length
          ? "partial"
          : "failed";
    const [audit] = await db
      .insert(applyAudit)
      .values({
        status,
        dryRun,
        updatedCount: created,
        failed: failures,
        result: { kind: "rebuild", products: reports.length, created, deleted, failedProducts },
        finishedAt: new Date(),
      })
      .returning({ id: applyAudit.id });
    finalAuditId = audit.id;
  }

  return {
    auditId: finalAuditId,
    dryRun,
    status,
    products: reports,
    created,
    deleted,
    failedProducts,
  };
}
