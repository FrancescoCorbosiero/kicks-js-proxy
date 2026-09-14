import type { SourceProduct } from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { skuKey } from "@/lib/skus";
import type { StoreVariation } from "@/server/store-json/model";
import {
  planRebuild,
  rebuildParentAttributes,
  type RebuildVariationPlan,
} from "@/server/store-json/rebuild-plan";

/**
 * The Publisher's planner: a catalog product → the WooCommerce payloads that
 * bring it into existence on the store.
 *
 * Until now the app could only ever ADJUST products the store already had —
 * `previewFromStore` walks the snapshot, and the apply drops every "create"
 * row. A supplier feed, though, brings genuinely new products: they land in
 * the catalog, get priced by the margin rules, and then sit there invisible
 * to customers forever. This closes that path.
 *
 * The variation half is NOT reinvented: it is the rebuild planner run against
 * an empty "before" state, so a published product is byte-for-byte the same
 * canonical shape a rebuild produces — same EU-normalized `pa_taglia` labels,
 * same SKU convention, same managed-stock semantics, same manual-lock
 * precedence. Publish and rebuild can never drift apart.
 *
 * Pure module: no HTTP, no DB — the executor (publish.ts) feeds it catalog
 * data and runs the writes.
 */

export interface PublishPlan {
  sku: string;
  title: string;
  /** POST /products body for the parent variable product. */
  parentBody: Record<string, unknown>;
  /** POST /products/{id}/variations/batch `create` rows. */
  variations: RebuildVariationPlan[];
  /** Canonical pa_taglia option list, ascending. */
  sizeOptions: string[];
  /** Created without any price (no ask, no manual lock) — listed for review. */
  unpricedSizes: string[];
  /** Catalog variants skipped because no EU size could be resolved. */
  skippedNoEu: number;
  /** Barcodes the planner refused to write, with the reason. */
  rejectedGtins: { sizeLabel: string; value: string; reason: string }[];
  /** Image URLs the parent will sideload, main image first. */
  images: string[];
}

/**
 * The identity a product needs on an EXTERNAL catalog, as plain names — before
 * anything has been resolved against the store's taxonomies. Google Merchant
 * Center and TikTok Shop key an offer on brand + identifier + category, and
 * until now a published product carried none of the three: name, sizes, price,
 * pictures, nothing else. Both sources fill this in — KicksDB sends brand,
 * gender and category outright; the feed's products get brand from the
 * supplier row and the rest from the shared title classifier.
 */
export interface IdentityNames {
  brand: string;
  /** Category path, broadest first: ["Air Jordan", "One"]. */
  categoryPath: string[];
  /** Source vocabulary as-is ("men", "women", "youth"…) — never re-coded here:
   *  the channel plugin owns the mapping to its own field values. */
  gender: string;
}

/** What the store answered when those names were resolved (or created). */
export interface ResolvedIdentity {
  /** product_brand term id — the native WooCommerce brands taxonomy. */
  brandId?: number;
  /** product_cat term ids, broadest first. */
  categoryIds?: number[];
  /** Global attribute bindings: pa_brand, pa_gender. */
  attributes?: { id: number; option: string }[];
}

/** The identity names a catalog product carries, empty strings dropped. */
export function identityNamesFor(catalog: SourceProduct): IdentityNames {
  return {
    brand: (catalog.brand ?? "").trim(),
    categoryPath: [catalog.category, catalog.secondaryCategory]
      .map((c) => (c ?? "").trim())
      .filter((c) => c.length > 0),
    gender: (catalog.gender ?? "").trim(),
  };
}

export interface PublishPlanInput {
  catalog: SourceProduct;
  config: AppConfig;
  /** Operator price locks keyed by canonical EU size (euNorm). */
  manualPrices?: Record<string, number>;
  /** Brand/category/gender already resolved to store term ids. */
  identity?: ResolvedIdentity;
  /** Global pa_taglia attribute id, when known — makes create bindings exact. */
  tagliaAttributeId?: number;
  /** Real per-size stock (euNorm → quantity) for feed-owned products. */
  stockBySize?: Record<string, number>;
  /** Send the extra product shots too, not just the main image. */
  includeGallery?: boolean;
  /** Hard cap on sideloaded images — Woo fetches each one synchronously. */
  maxImages?: number;
}

/**
 * Woo sideloads every `images[].src` by downloading it during the create call,
 * so a long gallery turns one product into a multi-second request (and a
 * timeout risks a half-made product). Keep the main shot plus a few.
 */
const DEFAULT_MAX_IMAGES = 6;

/** Only real http(s) URLs — a relative or empty src makes Woo 400 the create. */
function usableImages(catalog: SourceProduct, includeGallery: boolean, max: number): string[] {
  const candidates = [catalog.image, ...(includeGallery ? (catalog.gallery ?? []) : [])];
  const out: string[] = [];
  for (const raw of candidates) {
    const url = (raw ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (out.includes(url)) continue;
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Attach brand / categories / gender to a product body, in the shape the Woo
 * REST product schema actually takes: taxonomy fields are arrays of OBJECTS
 * ({ id }), exactly like `categories` — a bare id array is refused outright
 * ("brands[0] is not of type object").
 *
 * The brand is written BOTH ways on purpose: channel plugins disagree on where
 * to read it — some only know the native product_brand taxonomy, others only a
 * global pa_brand attribute — and a product invisible to the connector the
 * shop actually uses is no better than a product with no brand at all.
 */
function applyIdentity(body: Record<string, unknown>, identity: ResolvedIdentity | undefined): void {
  if (identity?.brandId != null) body.brands = [{ id: identity.brandId }];
  if (identity?.categoryIds?.length) {
    body.categories = identity.categoryIds.map((id) => ({ id }));
  }
  if (identity?.attributes?.length) {
    const existing = (body.attributes as Record<string, unknown>[] | undefined) ?? [];
    body.attributes = [
      ...existing,
      // Visible on the product page, never a variation axis: these describe the
      // product, they do not multiply its sizes.
      ...identity.attributes.map((a, i) => ({
        id: a.id,
        position: existing.length + i,
        visible: true,
        variation: false,
        options: [a.option],
      })),
    ];
  }
}

/** The keys applyIdentity may have added — used to retry without them. */
const IDENTITY_KEYS = ["brands", "categories"] as const;

/**
 * The same body with every identity field removed: the fallback when a store's
 * REST schema refuses one of them. Losing the brand is bad; losing the product
 * is worse, so a publish that trips on a taxonomy retries without it.
 */
export function withoutIdentity(
  body: Record<string, unknown>,
  identity: ResolvedIdentity | undefined,
): Record<string, unknown> {
  const out = { ...body };
  for (const key of IDENTITY_KEYS) delete out[key];
  const added = identity?.attributes?.length ?? 0;
  if (added > 0 && Array.isArray(out.attributes)) {
    out.attributes = (out.attributes as unknown[]).slice(0, out.attributes.length - added);
  }
  return out;
}

export function planPublish(input: PublishPlanInput): PublishPlan {
  const { catalog, config } = input;
  const sku = skuKey(catalog.sku);

  // The rebuild planner with nothing to carry over: no old variations, no
  // store product id. It resolves EU sizes, prices each one through the
  // margin rules (manual locks winning), and emits the create payloads.
  const rebuilt = planRebuild({
    parentSku: sku,
    storeProductId: 0,
    catalog,
    oldVariations: [],
    config,
    manualPrices: input.manualPrices,
    tagliaAttributeId: input.tagliaAttributeId,
    stockBySize: input.stockBySize,
  });

  const images = usableImages(
    catalog,
    input.includeGallery ?? false,
    input.maxImages ?? DEFAULT_MAX_IMAGES,
  );

  const parentBody: Record<string, unknown> = {
    name: catalog.title || sku,
    type: "variable",
    // Published straight to the storefront: the operator publishes a product
    // because they intend to sell it. Nothing is created without an explicit
    // selection, and the dry run shows the exact payloads first.
    status: "publish",
    sku,
    // The parent's option list must exist BEFORE the variations that bind to
    // it — same ordering constraint the rebuild works under.
    attributes: rebuildParentAttributes(null, rebuilt.parentSizeOptions, input.tagliaAttributeId),
  };
  if (catalog.description) parentBody.description = catalog.description;
  if (images.length > 0) parentBody.images = images.map((src) => ({ src }));

  // Identity for the external catalogs. The brand is written BOTH ways on
  // purpose: channel plugins disagree on where to read it — some only know the
  // native product_brand taxonomy, others only a global pa_brand attribute —
  // and a product that is invisible to the connector the shop actually uses is
  // no better than a product with no brand at all.
  applyIdentity(parentBody, input.identity);

  return {
    sku,
    title: catalog.title || sku,
    parentBody,
    variations: rebuilt.create,
    sizeOptions: rebuilt.parentSizeOptions,
    unpricedSizes: rebuilt.unpricedSizes,
    skippedNoEu: rebuilt.skippedNoEu,
    rejectedGtins: rebuilt.rejectedGtins,
    images,
  };
}

/**
 * The parent fields a FORCE REIMPORT refreshes on a product that already
 * exists. Deliberately narrow: identity and media only. Everything the store
 * owns — slug, SEO, taxonomies, menu order, meta — is never in this body, so
 * a reimport can restore a product's shape without undoing shop work.
 * Media is replaced only when asked: re-sideloading images on every reimport
 * would duplicate them in the media library.
 */
export function planReimportParent(
  plan: PublishPlan,
  opts: { replaceMedia: boolean; identity?: ResolvedIdentity },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: plan.title,
    // Already carries the identity attributes: planPublish appended them to
    // the same list. Only the taxonomy fields have to be re-stated.
    attributes: (plan.parentBody as { attributes: unknown }).attributes,
  };
  if (opts.replaceMedia && plan.images.length > 0) {
    body.images = plan.images.map((src) => ({ src }));
  }
  if (opts.identity?.brandId != null) body.brands = [{ id: opts.identity.brandId }];
  if (opts.identity?.categoryIds?.length) {
    body.categories = opts.identity.categoryIds.map((id) => ({ id }));
  }
  return body;
}

/**
 * The store-model variations a freshly published product really has, built by
 * pairing the plan's create rows with the ids Woo returned for them (batch
 * responses come back in request order — the same pairing the rebuild does).
 *
 * A row whose id is missing, zero or errored is DROPPED, never given a
 * placeholder: the snapshot is what the sync aims its price writes at, and an
 * invented id turns into an update against variation 0 — which Woo rejects,
 * and which collapses every size of the product into one entry for anything
 * that keys variations by id.
 */
export function publishedVariations(
  plan: PublishPlan,
  createdRows: { id?: number; error?: unknown }[],
): StoreVariation[] {
  const out: StoreVariation[] = [];
  plan.variations.forEach((v, i) => {
    const row = createdRows[i];
    const id = row && row.error == null && typeof row.id === "number" ? row.id : 0;
    if (id <= 0) return;
    out.push({
      id,
      sku: v.sku,
      regular_price: v.price != null ? v.price.toFixed(2) : null,
      sale_price: null,
      global_unique_id: v.upc,
      stock_quantity: null,
      manage_stock: false,
      stock_status: "instock",
      attributes: [{ name: "pa_taglia", option: v.sizeLabel }],
    } as StoreVariation);
  });
  return out;
}
