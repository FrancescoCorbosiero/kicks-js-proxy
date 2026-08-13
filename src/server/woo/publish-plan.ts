import type { SourceProduct } from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { skuKey } from "@/lib/skus";
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
  /** Image URLs the parent will sideload, main image first. */
  images: string[];
}

export interface PublishPlanInput {
  catalog: SourceProduct;
  config: AppConfig;
  /** Operator price locks keyed by canonical EU size (euNorm). */
  manualPrices?: Record<string, number>;
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

  return {
    sku,
    title: catalog.title || sku,
    parentBody,
    variations: rebuilt.create,
    sizeOptions: rebuilt.parentSizeOptions,
    unpricedSizes: rebuilt.unpricedSizes,
    skippedNoEu: rebuilt.skippedNoEu,
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
  opts: { replaceMedia: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: plan.title,
    attributes: (plan.parentBody as { attributes: unknown }).attributes,
  };
  if (opts.replaceMedia && plan.images.length > 0) {
    body.images = plan.images.map((src) => ({ src }));
  }
  return body;
}
