import type { ResolvedIdentity } from "./publish-plan";

/**
 * What a product on the store is MISSING, and the smallest patch that fills it.
 *
 * The premise: a supplier changes the shape of its data without warning, a
 * publish runs, and products land incomplete — no picture, no brand, no
 * category. Until now the only way back was the force reimport, which deletes
 * and re-creates every variation of the product: a demolition hammer for a
 * missing photograph, and one that costs the store its variation ids.
 *
 * So this planner is deliberately narrow, and every rule below follows from
 * one decision: repair is ADDITIVE. It fills fields that are empty and never
 * touches a field that holds something. A picture the operator uploaded by
 * hand, a category they curated, a brand they corrected — all of it outranks
 * whatever the source says, because the operator saw the product and the feed
 * did not. That is also what makes the pass safe to run again and again: the
 * second run finds nothing to do.
 *
 * Pure module: the shapes come from Woo's REST payloads, no client, no DB.
 */

/** The live product as Woo returns it, narrowed to what repair looks at. */
export interface LiveProduct {
  id: number;
  images?: unknown;
  brands?: unknown;
  categories?: unknown;
  attributes?: unknown;
}

/** What the source can supply for a product. */
export interface RepairSource {
  images: string[];
  identity: ResolvedIdentity | undefined;
  /**
   * What the taxonomy configuration says this product SHOULD carry. A field
   * the operator switched off is not a gap: without this the repair would
   * report "no brand" forever on a shop that keeps its brands elsewhere, and
   * the report would stop meaning anything.
   */
  wants: {
    /** The native product_brand taxonomy. */
    brandTaxonomy: boolean;
    /** The pa_brand attribute — a separate switch, some plugins read only it. */
    brandAttribute: boolean;
    category: boolean;
    gender: boolean;
  };
}

export type RepairField = "image" | "brand" | "category" | "gender";

export interface RepairPatch {
  /** The Woo product body to PATCH, empty when nothing is missing. */
  body: Record<string, unknown>;
  /** Which fields this patch fills — for the report and the dry run. */
  fills: RepairField[];
  /** Missing on the store AND unavailable from the source: nothing to do here. */
  unavailable: RepairField[];
}

/**
 * WooCommerce files a product with no category under its default term, so
 * "has a category" cannot mean "the array is non-empty". These are the default
 * term's slugs across the locales this app runs in; a product carrying only
 * that is, for our purposes, uncategorised.
 */
const DEFAULT_CATEGORY_SLUGS = new Set(["uncategorized", "senza-categoria"]);

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Attribute names Woo reports for our identity bindings, however they are cased. */
function attributeMatches(attribute: Record<string, unknown>, id: number): boolean {
  return typeof attribute.id === "number" && attribute.id === id;
}

function hasOptions(attribute: Record<string, unknown>): boolean {
  const options = attribute.options;
  return Array.isArray(options) && options.some((o) => String(o ?? "").trim() !== "");
}

/**
 * Diff one live product against what its source can give, and return only the
 * additions. An empty `fills` means the product is already whole.
 */
export function planRepair(live: LiveProduct, source: RepairSource): RepairPatch {
  const body: Record<string, unknown> = {};
  const fills: RepairField[] = [];
  const unavailable: RepairField[] = [];

  // ---- media ----
  const liveImages = asArray(live.images);
  if (liveImages.length === 0) {
    if (source.images.length > 0) {
      body.images = source.images.map((src) => ({ src }));
      fills.push("image");
    } else {
      unavailable.push("image");
    }
  }

  // ---- brand (native taxonomy) ----
  const liveBrands = asArray(live.brands);
  if (source.wants.brandTaxonomy && liveBrands.length === 0) {
    if (source.identity?.brandId != null) {
      body.brands = [{ id: source.identity.brandId }];
      fills.push("brand");
    } else {
      unavailable.push("brand");
    }
  }

  // ---- category ----
  const realCategories = asArray(live.categories).filter(
    (c) => !DEFAULT_CATEGORY_SLUGS.has(String(c.slug ?? "").toLowerCase()),
  );
  if (source.wants.category && realCategories.length === 0) {
    if (source.identity?.categoryIds?.length) {
      body.categories = source.identity.categoryIds.map((id) => ({ id }));
      fills.push("category");
    } else {
      unavailable.push("category");
    }
  }

  // ---- identity attributes (pa_brand, pa_gender) ----
  // Woo replaces the whole attribute array on update, so the live ones are
  // carried over verbatim: losing pa_taglia here would orphan every variation.
  const liveAttributes = asArray(live.attributes);
  const wantedAttributes = (source.identity?.attributes ?? []).filter((a) =>
    a.field === "brand" ? source.wants.brandAttribute : source.wants.gender,
  );
  const missingAttributes = wantedAttributes.filter(
    (a) => !liveAttributes.some((l) => attributeMatches(l, a.id) && hasOptions(l)),
  );
  if (missingAttributes.length > 0) {
    body.attributes = [
      ...liveAttributes.filter((l) => !missingAttributes.some((m) => attributeMatches(l, m.id))),
      ...missingAttributes.map((a, i) => ({
        id: a.id,
        position: liveAttributes.length + i,
        visible: true,
        variation: false,
        options: [a.option],
      })),
    ];
    // Each binding names the fact it carries, so the report counts distinct
    // facts rather than writes: the brand attribute and the brand taxonomy are
    // the same fact told to two different readers.
    for (const a of missingAttributes) {
      if (!fills.includes(a.field)) fills.push(a.field);
    }
  }

  // A gender the source states but the store cannot hold (no pa_gender term,
  // or no identity resolved at all) is missing from the product all the same —
  // say so, instead of reporting the product whole.
  const genderBound = (source.identity?.attributes ?? []).some((a) => a.field === "gender");
  if (source.wants.gender && !genderBound && !fills.includes("gender")) {
    unavailable.push("gender");
  }

  return { body, fills, unavailable };
}
