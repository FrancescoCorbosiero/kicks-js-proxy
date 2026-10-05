import "server-only";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getActiveConfig } from "@/server/config/repo";
import {
  getSnapshotInfo,
  listSizelessStoreSkus,
  listStoreSkus,
  upsertSnapshotProducts,
} from "@/server/store-json/repo";
import {
  pagePublishTargets,
  type PublishPage,
  type PublishQuery,
} from "@/lib/publish-page";
import { getAnyBySkus, listPublishCandidates, type PublishCandidate } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { manualPriceFor } from "@/server/overrides/model";
import { gsOwnedProducts } from "@/server/feeds/owner";
import { sourceEuSize } from "@/server/store-json/match";
import type { StoreProductModel } from "@/server/store-json/model";
import { skuKey } from "@/lib/skus";
import {
  planPublish,
  planReimportParent,
  publishedVariations,
  withoutIdentity,
  type PublishPlan,
} from "./publish-plan";
import { buildIdentityResolver } from "./identity";
import { toStoreProduct } from "./store-product";
import { getWooClient, type WooClient, type WooRestProduct, type WooRestVariation } from "./client";
import { withTaxonomyCache } from "./taxonomy-cache";
import { assertSnapshotIsThisStore } from "@/server/woo/site-guard";

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

/**
 * "complete": the product is on the store WITHOUT a single size — a publish
 * that broke half-way (the parent was created, its sizes never were). It
 * sells nothing, so it is not "already published": it gets its sizes.
 */
export type PublishAction = "create" | "reimport" | "complete" | "skip";

/**
 * Why a product was left alone. A CODE, not a sentence: these are shown to a
 * non-technical operator in their own language, so the wording belongs in the
 * dictionaries, not in the executor.
 */
export type PublishSkipReason = "alreadyOnStore" | "feedDelisted" | "inProgress";

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
  /** Barcodes not written (unusable or shared by two sizes) — see rebuild-plan. */
  rejectedGtins: { sizeLabel: string; value: string; reason: string }[];
  /** Sizes that went out WITH a GTIN — what a channel can actually match on. */
  gtins: number;
  images: number;
  reason: PublishSkipReason | null;
  error: string | null;
}

export interface PublishOutcome {
  auditId: string;
  /**
   * Identity taxonomies the store would not take (absent, or the REST key
   * cannot create terms). Publishing still happened — the products are simply
   * missing that field for external catalogs.
   */
  identitySkipped: string[];
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: PublishProductReport[];
  created: number; // parent products created
  reimported: number; // existing parents refreshed
  completed: number; // parents on the store without sizes, given their sizes
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

/** No usable answer came back: a timeout, a dropped connection, a gateway error. */
function answerLost(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status == null || status >= 500;
}

/** WooCommerce refused the SKU as already taken. */
function skuTaken(e: unknown): boolean {
  const err = e as { status?: number; body?: string; message?: string };
  return err?.status === 400 && /product_invalid_sku/.test(err.body ?? err.message ?? "");
}

/**
 * Create the parent — or find it, when the create's answer cannot be trusted.
 *
 * A lost answer (a timeout, Cloudflare's 524 after 100 s) usually means
 * WordPress went on and created the product anyway; "SKU already used" right
 * after a lookup that found nothing means the same thing seen from the other
 * side. Either way the SKU is looked up again before anything is called a
 * failure, and a product found is carried on with — given its sizes — instead
 * of being left on the shop with none.
 */
async function createOrAdopt(
  client: WooClient,
  sku: string,
  body: Record<string, unknown>,
  identity: Parameters<typeof withoutIdentity>[1],
  identityRejected: Set<string>,
): Promise<{ product: WooRestProduct; adopted: boolean }> {
  try {
    try {
      return { product: await client.createProduct(body), adopted: false };
    } catch (e) {
      const field = identityRejection(e);
      if (!field) throw e;
      identityRejected.add(field);
      return { product: await client.createProduct(withoutIdentity(body, identity)), adopted: false };
    }
  } catch (e) {
    if (!answerLost(e) && !skuTaken(e)) throw e;
    const found = (await client.findProductsBySku(sku))[0];
    if (!found) throw e;
    return { product: found, adopted: true };
  }
}

/**
 * How many sizes the product's own record lists (WooCommerce puts the
 * variation ids on the parent), or null when it does not say.
 */
function listedSizes(product: WooRestProduct): number | null {
  const ids = (product as { variations?: unknown }).variations;
  return Array.isArray(ids) ? ids.length : null;
}

/**
 * Its sizes, read live — or null when the read cannot be trusted. "No sizes"
 * is only believed when the product's own record agrees: a cache in front of
 * the shop answering the sizes endpoint from before they existed would
 * otherwise make the run give a product a second set of sizes.
 */
async function readSizes(client: WooClient, product: WooRestProduct): Promise<WooRestVariation[] | null> {
  let sizes: WooRestVariation[];
  try {
    sizes = await client.getAllVariations(product.id);
  } catch {
    return null;
  }
  if (sizes.length === 0 && (listedSizes(product) ?? 0) > 0) {
    console.warn(
      `[publish] product ${product.id} (${product.sku}): its record lists ${listedSizes(product)} sizes but ` +
        `the sizes endpoint answered none — treated as published, nothing added. A cache in front ` +
        `of the shop serving /wp-json is the usual cause.`,
    );
    return null;
  }
  return sizes;
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
/**
 * Woo REST rejects a whole request when one parameter does not fit its schema,
 * and stores disagree on the shape of the identity taxonomies (a brands plugin
 * variant, an older core, a filter). Losing the brand is bad; losing the
 * product is worse — so a 400 naming one of those fields is retried once
 * without them, and reported instead of thrown.
 */
function identityRejection(e: unknown): string | null {
  if ((e as { status?: number })?.status !== 400) return null;
  const message = e instanceof Error ? e.message : String(e);
  for (const field of ["brands", "categories", "attributes"]) {
    if (new RegExp(`\\b${field}\\b`).test(message)) return field;
  }
  return null;
}

async function resolveTagliaId(client: WooClient): Promise<number | undefined> {
  try {
    const taxonomies = await client.getAttributeTaxonomies();
    return taxonomies.find((t) => t.slug.toLowerCase().includes("taglia"))?.id;
  } catch {
    return undefined; // name-binding fallback still works
  }
}

/**
 * A catalog product the Publish tab can act on, and whether the store has it.
 *
 * Deliberately NARROWER than the catalog row it comes from: every field here
 * is serialized into the page once per candidate, and the candidate list is
 * the whole unpublished catalog. Anything the tab does not render is weight
 * the browser parses for nothing — so this is a pick, not a spread.
 */
export type PublishTarget = Pick<
  PublishCandidate,
  | "sku"
  | "title"
  | "brand"
  | "image"
  | "source"
  | "category"
  | "secondaryCategory"
  | "minAsk"
  | "variantCount"
> & {
  onStore: boolean;
  /** On the store, but without a single size: listed again, completed by the run. */
  sizeless: boolean;
};

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
export async function listPublishTargets(
  query: PublishQuery = {},
  limit?: number,
): Promise<PublishPage<PublishTarget> & { hasSnapshot: boolean }> {
  const config = await getActiveConfig();
  // The SKU set and the "is there a snapshot at all" flag, WITHOUT the blob:
  // this runs on every render of the tab, including the one that follows each
  // publish call, and deserializing the whole store to ask "does it have X"
  // is how the dev server ran out of heap.
  const [info, storeSkus, sizeless, rows] = await Promise.all([
    getSnapshotInfo().catch(() => null),
    listStoreSkus(),
    listSizelessStoreSkus(),
    listPublishCandidates(config.source.market),
  ]);
  // Filtered and sliced HERE: the whole delta stays on the server, and only a
  // page of it is serialized into the page the browser has to parse.
  const page = pagePublishTargets(
    rows.map((r) => ({
      sku: r.sku,
      title: r.title,
      brand: r.brand,
      image: r.image,
      source: r.source,
      category: r.category,
      secondaryCategory: r.secondaryCategory,
      minAsk: r.minAsk,
      variantCount: r.variantCount,
      // A product with no sizes sells nothing: not published yet.
      onStore: storeSkus.has(skuKey(r.sku)) && !sizeless.has(skuKey(r.sku)),
      sizeless: sizeless.has(skuKey(r.sku)),
    })),
    query,
    limit,
  );
  return { ...page, hasSnapshot: info != null };
}

/**
 * Every SKU the filters match — the whole pool, not the page the list shows.
 * "Select all" means all: the list stops at PAGE_LIMIT rows to keep the page
 * light, but the operator selecting everything wants everything, and a SKU
 * is a few bytes where a rendered row is not.
 */
export async function listPublishTargetSkus(query: PublishQuery = {}): Promise<string[]> {
  const page = await listPublishTargets(query, Number.MAX_SAFE_INTEGER);
  return page.candidates.map((c) => c.sku);
}

/**
 * SKUs a live publish is working on right now, in this process.
 *
 * A request the proxy in front gave up on (Cloudflare answers 524 after 100
 * seconds) keeps running here, and the operator's natural next move is to
 * publish the same SKUs again. Two calls creating one SKU both pass the live
 * lookup before either creates — exactly the duplicate parent that lookup
 * exists to prevent. So a SKU already in flight is skipped instead. One app
 * container per shop (docs/deploy.md): this process is the whole picture.
 * On globalThis because route and action bundles each get their own copy of
 * this module.
 */
const publishing = ((globalThis as { __storeHubPublishing?: Set<string> }).__storeHubPublishing ??=
  new Set<string>());

/**
 * Publish a set of catalog SKUs to the store. Each product is independent:
 * one failure never blocks the rest, and a product that fails mid-way is
 * reported with its parent id so it can be finished or removed by hand.
 */
export async function publishProducts(
  skus: string[],
  options: PublishOptions,
): Promise<PublishOutcome> {
  const uniqueSkus = [...new Set(skus.map(skuKey))];
  if (options.dryRun) return publishClaimed(uniqueSkus, options, new Set());
  // Claimed before the first await, so two concurrent calls cannot both see
  // a SKU as free: the check and the claim happen in one synchronous step.
  const inFlight = new Set(uniqueSkus.filter((sku) => publishing.has(sku)));
  const claimed = uniqueSkus.filter((sku) => !inFlight.has(sku));
  for (const sku of claimed) publishing.add(sku);
  try {
    return await publishClaimed(uniqueSkus, options, inFlight);
  } finally {
    for (const sku of claimed) publishing.delete(sku);
  }
}

async function publishClaimed(
  uniqueSkus: string[],
  options: PublishOptions,
  inFlight: Set<string>,
): Promise<PublishOutcome> {
  const { dryRun } = options;
  await assertSnapshotIsThisStore();
  const config = await getActiveConfig();
  const market = config.source.market;
  // Small batches each need the store's brand/category/attribute lists:
  // remembered between them instead of read again every time.
  const client = withTaxonomyCache(getWooClient());
  const overrides = await getOverrides().catch(() => null);

  const catalogEntries = await getAnyBySkus(market, uniqueSkus);
  // Product-level ownership: a GS-owned SKU publishes the FEED's variant set
  // (real sizes, real stock, presented prices), exactly like the rebuild.
  const gsOwned = await gsOwnedProducts(uniqueSkus, market, overrides);

  const reports: PublishProductReport[] = [];
  const published: { plan: PublishPlan; product: StoreProductModel }[] = [];
  /**
   * Products the live check found the store already carrying. They are skipped,
   * correctly — but the ONLY reason they were offered is that the snapshot did
   * not know about them, and skipping used to leave it not knowing. So the tab
   * offered them again on the very next render, and on every render after that.
   */
  const reconciled: StoreProductModel[] = [];
  // Identity fields this store's REST schema refused — reported once, not per
  // product, and never fatal.
  const identityRejected = new Set<string>();
  const tagliaAttributeId = await resolveTagliaId(client);
  // Brand / category / gender resolved ONCE for the whole batch: 300 products
  // of the same brand must not mean 300 term lookups. Best-effort — a store
  // that cannot take a taxonomy still gets its products.
  const identity = dryRun
    ? null
    : await buildIdentityResolver(
        client,
        uniqueSkus
          .map((sku) => gsOwned.get(sku)?.product ?? catalogEntries.get(sku))
          .filter((c): c is NonNullable<typeof c> => c != null),
        config.taxonomy,
      ).catch((e) => {
        console.warn("[publish] identity skipped:", e instanceof Error ? e.message : String(e));
        return null;
      });
  let created = 0;
  let reimported = 0;
  let completed = 0;
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
      rejectedGtins: [],
      gtins: 0,
      images: 0,
      reason: null,
      error: null,
    };
    reports.push(report);

    // Another request is creating this very SKU right now (see `publishing`).
    if (inFlight.has(sku)) {
      report.reason = "inProgress";
      return;
    }

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

      const resolvedIdentity = identity?.for(catalog);
      const plan = planPublish({
        catalog,
        config,
        manualPrices,
        tagliaAttributeId,
        identity: resolvedIdentity,
        stockBySize: gs?.stockBySize,
        includeGallery: options.includeGallery,
      });
      report.sizes = plan.variations.map((v) => v.sizeLabel);
      report.unpricedSizes = plan.unpricedSizes;
      report.skippedNoEu = plan.skippedNoEu;
      report.rejectedGtins = plan.rejectedGtins;
      report.gtins = plan.variations.filter((v) => v.upc).length;
      report.images = plan.images.length;

      if (plan.variations.length === 0) {
        report.error = "no EU-sized variants to create";
        return;
      }

      // LIVE presence check — never the snapshot. Creating a second parent for
      // a SKU the store already has is the one unrecoverable mistake here.
      const existing = await client.findProductsBySku(sku);
      const onStore = existing[0] ?? null;
      // What it has. Null when unreadable or untrustworthy right now: then it
      // counts as published, and nothing is filed for it — a product recorded
      // with no sizes would make the sync skip its prices.
      const onStoreSizes = onStore ? await readSizes(client, onStore) : null;
      const sizeless = onStore != null && onStoreSizes != null && onStoreSizes.length === 0;

      if (onStore && !sizeless && !options.force) {
        report.action = "skip";
        report.storeProductId = onStore.id;
        report.reason = "alreadyOnStore";
        // Close the loop that kept this product on the list: read back what
        // the store actually has and record THAT. Not the plan — the plan is
        // what we would have written, not what is there.
        if (!dryRun && onStoreSizes) reconciled.push(toStoreProduct(onStore, onStoreSizes));
        return;
      }

      report.action = !onStore ? "create" : options.force ? "reimport" : "complete";
      if (dryRun) {
        report.storeProductId = onStore?.id ?? null;
        return;
      }

      let productId: number;
      // Woo's answer to the create batch, in request order: the only place the
      // real variation ids exist. The snapshot patch below needs them.
      let createdRows: { id?: number; error?: unknown }[] = [];
      if (onStore) {
        // Refresh identity + option list, then replace the variation set (a
        // product being completed has none to replace).
        productId = onStore.id;
        const reimportBody = planReimportParent(plan, {
          replaceMedia: options.replaceMedia ?? false,
          identity: resolvedIdentity,
        });
        try {
          await client.updateProduct(productId, reimportBody);
        } catch (e) {
          const field = identityRejection(e);
          if (!field) throw e;
          identityRejected.add(field);
          await client.updateProduct(productId, withoutIdentity(reimportBody, resolvedIdentity));
        }
        const old = onStoreSizes ?? (await client.getAllVariations(productId));
        const res = await client.batchVariations(productId, {
          delete: old.map((v) => v.id),
          create: plan.variations.map((v) => v.payload),
        });
        createdRows = res.create;
        variations += res.create.filter((r) => r.error == null).length;
        const failedRows = res.create.filter((r) => r.error != null);
        if (failedRows.length > 0) {
          report.error = `${failedRows.length}/${plan.variations.length} variations failed: ${failedRows[0].error?.message ?? "unknown"}`;
        }
        if (report.action === "complete") completed += 1;
        else reimported += 1;
      } else {
        const { product: parent, adopted } = await createOrAdopt(
          client,
          sku,
          plan.parentBody,
          resolvedIdentity,
          identityRejected,
        );
        productId = parent.id;
        report.permalink = parent.permalink ?? null;
        if (adopted) {
          // Found after a lost answer. With sizes already (or sizes that cannot
          // be read reliably), some other run finished it: published, nothing
          // to add. Without, it gets them now.
          const sizes = await readSizes(client, parent);
          if (sizes == null || sizes.length > 0) {
            report.action = "skip";
            report.reason = "alreadyOnStore";
            report.storeProductId = productId;
            if (sizes) reconciled.push(toStoreProduct(parent, sizes));
            return;
          }
        }
        const res = await client.batchVariations(productId, {
          create: plan.variations.map((v) => v.payload),
        });
        createdRows = res.create;
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
          variations: publishedVariations(plan, createdRows),
        } as StoreProductModel,
      });
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
  });

  // Patch the snapshot so a published product immediately counts as "on the
  // store" — it must not be offered for publishing again on the next render.
  //
  // Done in SQL, over the products that actually changed. Reading the whole
  // store in to swap a couple of hundred entries and handing it all back to be
  // re-serialized cost ~140 MB in and ~140 MB out PER BATCH on a large shop,
  // and the tab sends batch after batch: that churn, next to a dev server's own
  // footprint, is what ran the heap out mid-publish.
  if (!dryRun && (published.length > 0 || reconciled.length > 0)) {
    await upsertSnapshotProducts([...published.map((p) => p.product), ...reconciled]);
  }

  const failed = reports.filter((r) => r.error != null).length;
  const skipped = reports.filter((r) => r.action === "skip" && r.error == null).length;
  const acted = created + reimported + completed;
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
        completed,
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
    identitySkipped: [...new Set([...(identity?.skipped ?? []), ...identityRejected])],
    products: reports,
    created,
    reimported,
    completed,
    variations,
    skipped,
    failed,
  };
}
