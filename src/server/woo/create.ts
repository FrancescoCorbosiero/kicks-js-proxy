import "server-only";
import { eq } from "drizzle-orm";
import type { SourceProduct } from "@core/core-spine";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";
import { getAnyBySkus, listCatalogEntries } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { manualPriceFor } from "@/server/overrides/model";
import { gsOwnedProducts } from "@/server/feeds/owner";
import { GS_FEED, activeFeedSkus } from "@/server/feeds/repo";
import { planRebuild, rebuildParentAttributes } from "@/server/store-json/rebuild-plan";
import type { StoreProductModel, StoreVariation } from "@/server/store-json/model";
import { sourceEuSize } from "@/server/store-json/match";
import { skuKey } from "@/lib/skus";
import { getWooClient, type WooClient } from "./client";

/**
 * Create WHOLE new products on the store from a source of truth — the missing
 * half of the sync: the apply only updates existing variations, so a feed/
 * catalog SKU with no Woo parent (many GoldenSneakers products aren't carried)
 * is otherwise unreachable. Each product is created from ITS owner's data
 * (GS feed or KicksDB catalog), with the same canonical identity the rebuild
 * produces (EU sizes, {sku}-EU{label} SKUs, GTINs, banded/passthrough prices,
 * real stock for feed products).
 *
 * Deliberately minimal parent: name, sku, type=variable, pa_taglia. NO media
 * (WP sideload is slow — the media pipeline is a separate phase) unless the
 * caller opts in, and status is the caller's choice (draft by default so a
 * bulk run never dumps bare products onto the storefront). Woo enforces SKU
 * uniqueness, so a product that already exists fails cleanly and is reported.
 */

export type CreateStatus = "draft" | "publish";

export interface CreateProductReport {
  sku: string;
  owner: "kicksdb" | "goldensneakers";
  title: string;
  sizes: string[];
  newProductId: number | null;
  error: string | null;
}

export interface CreateOutcome {
  auditId: string;
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: CreateProductReport[];
  created: number; // products created
  variationsCreated: number;
  failed: number;
}

export interface CreatableEntry {
  sku: string;
  owner: "kicksdb" | "goldensneakers";
  title: string;
  sizes: number;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * Products a source of truth carries that the store DOESN'T have yet.
 * GS-owned SKUs come from the feed; the rest of the catalog from KicksDB.
 * Scope is bounded by the pulled snapshot's product SKUs.
 */
export async function listCreatableProducts(): Promise<CreatableEntry[]> {
  const config = await getActiveConfig();
  const market = config.source.market;
  const snapshot = await getActiveSnapshot();
  const storeSkus = new Set(
    (snapshot?.products ?? []).map((p) => (p.sku ? skuKey(p.sku) : "")).filter(Boolean),
  );

  const gsSkus = await activeFeedSkus(GS_FEED);
  const catalog = await listCatalogEntries(market);
  const overrides = await getOverrides().catch(() => null);

  // GS-owned creatable products (feed has full data + real stock).
  const missingGs = [...gsSkus].filter((s) => !storeSkus.has(skuKey(s)));
  const gsOwned = missingGs.length
    ? await gsOwnedProducts(missingGs, market, overrides)
    : new Map<string, { product: SourceProduct }>();

  const out: CreatableEntry[] = [];
  const seen = new Set<string>();
  for (const [sku, gs] of gsOwned) {
    seen.add(sku);
    out.push({
      sku,
      owner: "goldensneakers",
      title: gs.product.title || sku,
      sizes: gs.product.variants.length,
    });
  }
  // KicksDB catalog products not on the store and not GS-owned. (The exact
  // size count materializes at dry-run; the light list query omits it.)
  for (const e of catalog) {
    const key = skuKey(e.sku);
    if (storeSkus.has(key) || seen.has(key) || gsSkus.has(key)) continue;
    seen.add(key);
    out.push({ sku: e.sku, owner: "kicksdb", title: e.title || e.sku, sizes: 0 });
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Resolve one SKU to its owner's SourceProduct + real stock (GS) if any. */
async function resolveForCreate(
  sku: string,
  market: string,
  gsOwned: Map<string, { product: SourceProduct; stockBySize: Record<string, number> }>,
  catalog: Map<string, SourceProduct>,
): Promise<{ product: SourceProduct; owner: "kicksdb" | "goldensneakers"; stockBySize?: Record<string, number> } | null> {
  const gs = gsOwned.get(skuKey(sku));
  if (gs) return { product: gs.product, owner: "goldensneakers", stockBySize: gs.stockBySize };
  const cat = catalog.get(skuKey(sku));
  if (cat) return { product: cat, owner: "kicksdb" };
  return null;
}

export async function createProducts(
  skus: string[],
  dryRun: boolean,
  options: { status?: CreateStatus; withImages?: boolean; auditId?: string } = {},
): Promise<CreateOutcome> {
  const config = await getActiveConfig();
  const market = config.source.market;
  const status: CreateStatus = options.status ?? "draft";
  const client = getWooClient();
  const overrides = await getOverrides().catch(() => null);

  const uniqueSkus = [...new Set(skus.map(skuKey))];
  const gsOwned = await gsOwnedProducts(uniqueSkus, market, overrides);
  const catalog = await getAnyBySkus(market, uniqueSkus);

  const reports: CreateProductReport[] = [];
  const created: { sku: string; product: StoreProductModel }[] = [];
  const tagliaCache: { id?: number; fetched: boolean } = { fetched: false };
  let createdCount = 0;
  let variationsCreated = 0;

  await forEachLimit(uniqueSkus, 3, async (sku) => {
    const report: CreateProductReport = {
      sku,
      owner: "kicksdb",
      title: "",
      sizes: [],
      newProductId: null,
      error: null,
    };
    reports.push(report);

    try {
      const resolved = await resolveForCreate(sku, market, gsOwned, catalog);
      if (!resolved) {
        report.error = "no source data (not in the GS feed nor the KicksDB catalog)";
        return;
      }
      report.owner = resolved.owner;
      report.title = resolved.product.title || sku;

      // Reuse the rebuild planner with NO existing variations: it yields the
      // canonical create payloads (identity, price, GTIN, stock) directly.
      const tagliaAttributeId = await resolveTagliaId(client, tagliaCache);
      const manualPrices: Record<string, number> = {};
      if (overrides) {
        for (const v of resolved.product.variants) {
          const eu = sourceEuSize(v);
          if (!eu) continue;
          const locked = manualPriceFor(overrides, resolved.product.sku, eu);
          if (locked != null) manualPrices[eu] = locked;
        }
      }
      const plan = planRebuild({
        parentSku: sku,
        storeProductId: 0, // no parent yet
        catalog: resolved.product,
        oldVariations: [],
        config,
        manualPrices,
        tagliaAttributeId,
        stockBySize: resolved.stockBySize,
      });
      report.sizes = plan.create.map((c) => c.sizeLabel);
      if (plan.create.length === 0) {
        report.error = "source has no EU-sized, priceable variants";
        return;
      }
      if (dryRun) return;

      // 1. Create the parent variable product with its pa_taglia option list.
      const parentBody: Record<string, unknown> = {
        name: report.title,
        sku: skuKey(sku),
        type: "variable",
        status,
        attributes: rebuildParentAttributes(null, plan.parentSizeOptions, tagliaAttributeId),
      };
      if (options.withImages && resolved.product.image) {
        parentBody.images = [{ src: resolved.product.image }]; // WP sideloads — slow
      }
      const { id: newId } = await client.createProduct(parentBody);
      report.newProductId = newId;

      // 2. Create the variation set.
      const res = await client.batchVariations(newId, {
        create: plan.create.map((c) => c.payload),
      });
      const okRows = res.create.filter((r) => r.error == null && r.id != null);
      const failedRows = res.create.filter((r) => r.error != null);
      variationsCreated += okRows.length;
      if (failedRows.length > 0) {
        report.error = `${failedRows.length}/${plan.create.length} variations failed: ${failedRows[0].error?.message ?? "unknown"}`;
      }
      createdCount += 1;

      created.push({
        sku: skuKey(sku),
        product: {
          id: newId,
          sku: skuKey(sku),
          name: report.title,
          status,
          attributes: rebuildParentAttributes(null, plan.parentSizeOptions, tagliaAttributeId),
          variations: plan.create.map<StoreVariation>((c, i) => ({
            id: res.create[i]?.id ?? 0,
            sku: c.sku,
            regular_price: c.price != null ? c.price.toFixed(2) : null,
            sale_price: null,
            global_unique_id: c.upc,
            stock_quantity: resolved.stockBySize?.[c.euNorm] ?? null,
            manage_stock: resolved.stockBySize != null,
            stock_status:
              resolved.stockBySize == null || (resolved.stockBySize[c.euNorm] ?? 0) > 0
                ? "instock"
                : "outofstock",
            attributes: [{ name: "pa_taglia", option: c.sizeLabel }],
          })),
        },
      });
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  });

  // Append the new products to the snapshot so the next sync sees them.
  if (!dryRun && created.length > 0) {
    try {
      const snapshot = await getActiveSnapshot();
      if (snapshot) {
        snapshot.products = [
          ...snapshot.products,
          ...created.filter((c) => !snapshot.products.some((p) => skuKey(p.sku) === c.sku)).map((c) => c.product),
        ];
        const info = await getSnapshotInfo();
        await saveSnapshot(snapshot, info?.source ?? "rest");
      }
    } catch (e) {
      console.warn("[create] snapshot append skipped:", e instanceof Error ? e.message : String(e));
    }
  }

  const failed = reports.filter((r) => r.error != null).length;
  const runStatus: ApplyAuditRow["status"] = dryRun
    ? "dry_run"
    : failed === 0
      ? "applied"
      : createdCount > 0
        ? "partial"
        : "failed";

  const failures = reports
    .filter((r) => r.error != null)
    .map((r) => ({ stockxVariantId: `create:${r.sku}`, error: r.error! }));

  let finalAuditId: string;
  if (options.auditId) {
    const prev = (await db.select().from(applyAudit).where(eq(applyAudit.id, options.auditId)).limit(1))[0];
    const prevResult = (prev?.result ?? {}) as Record<string, number>;
    const prevFailed = Array.isArray(prev?.failed) ? prev.failed : [];
    await db
      .update(applyAudit)
      .set({
        status: runStatus,
        updatedCount: (prev?.updatedCount ?? 0) + createdCount,
        failed: [...prevFailed, ...failures],
        result: {
          kind: "create",
          products: (prevResult.products ?? 0) + reports.length,
          created: (prevResult.created ?? 0) + createdCount,
          variationsCreated: (prevResult.variationsCreated ?? 0) + variationsCreated,
          failed: (prevResult.failed ?? 0) + failed,
        },
        finishedAt: new Date(),
      })
      .where(eq(applyAudit.id, options.auditId));
    finalAuditId = options.auditId;
  } else {
    const [audit] = await db
      .insert(applyAudit)
      .values({
        status: runStatus,
        dryRun,
        updatedCount: createdCount,
        failed: failures,
        result: { kind: "create", products: reports.length, created: createdCount, variationsCreated, failed },
        finishedAt: new Date(),
      })
      .returning({ id: applyAudit.id });
    finalAuditId = audit.id;
  }

  return {
    auditId: finalAuditId,
    dryRun,
    status: runStatus,
    products: reports,
    created: createdCount,
    variationsCreated,
    failed,
  };
}

async function resolveTagliaId(
  client: WooClient,
  cache: { id?: number; fetched: boolean },
): Promise<number | undefined> {
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
