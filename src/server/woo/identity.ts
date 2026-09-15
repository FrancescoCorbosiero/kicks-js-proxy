import "server-only";
import type { SourceProduct } from "@core/core-spine";
import { identityNamesFor, type ResolvedIdentity } from "./publish-plan";
import type { TaxonomyConfig } from "@core/config";
import type { WooClient } from "./client";

/**
 * Resolve brand / category / gender NAMES to the store's own term ids, once
 * per publish run — creating what the store does not have yet.
 *
 * Every lookup here is best-effort by design. A store on an older WooCommerce
 * has no brands taxonomy; a REST key may be allowed to write products but not
 * to create terms. Neither is a reason to refuse to publish a product: the
 * identity we can resolve is attached, the rest is skipped, and the run
 * reports what it could not do.
 */

/** Global attributes we bind product identity to, beyond pa_taglia. */
const IDENTITY_ATTRIBUTES = [
  { key: "brand" as const, slug: "pa_brand", name: "Brand", match: /brand|marca/i },
  { key: "gender" as const, slug: "pa_gender", name: "Gender", match: /gender|genere/i },
];

export interface IdentityResolver {
  /** The identity to attach to one catalog product. */
  for(catalog: SourceProduct): ResolvedIdentity;
  /** Taxonomies that could not be reached or created — reported, never thrown. */
  readonly skipped: string[];
}

/** Case/space-insensitive term key: "Air Jordan" and "air  jordan" are one term. */
const termKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Prepare the resolver for a batch: read the store's taxonomies once, create
 * every missing term up front, then hand out plain lookups per product.
 */
export async function buildIdentityResolver(
  client: WooClient,
  catalogs: SourceProduct[],
  taxonomy: TaxonomyConfig,
): Promise<IdentityResolver> {
  const skipped: string[] = [];
  const wanted = catalogs.map((c) => identityNamesFor(c, taxonomy));

  const brands = new Map<string, number>();
  const categories = new Map<string, number>();
  const attributeTerms = new Map<string, Map<string, number>>();
  const attributeIds = new Map<string, number>();

  // ---- brands (native product_brand taxonomy) ----
  const brandNames = taxonomy.write.brandTaxonomy
    ? [...new Map(wanted.filter((w) => w.brand).map((w) => [termKey(w.brand), w.brand])).values()]
    : [];
  if (brandNames.length > 0) {
    try {
      const existing = await client.listBrands();
      for (const b of existing) brands.set(termKey(b.name), b.id);
      for (const name of brandNames) {
        if (brands.has(termKey(name))) continue;
        const created = await client.createBrand(name);
        if (created) brands.set(termKey(created.name), created.id);
        else {
          skipped.push("product_brand");
          break; // the taxonomy is absent or read-only — stop hammering it
        }
      }
    } catch {
      skipped.push("product_brand");
    }
  }

  // ---- categories (product_cat, path parent → child) ----
  const paths = wanted.map((w) => w.categoryPath).filter((p) => p.length > 0);
  if (paths.length > 0) {
    try {
      const existing = await client.listCategories();
      // Keyed by "parentId/name" so a child never collides with a same-named
      // category under a different parent ("One" under Air Jordan vs Yeezy).
      for (const c of existing) categories.set(`${c.parent ?? 0}/${termKey(c.name)}`, c.id);
      for (const path of paths) {
        let parent = 0;
        for (const name of path) {
          const key = `${parent}/${termKey(name)}`;
          let id = categories.get(key);
          if (id == null) {
            const created = await client.createCategory(name, parent || undefined);
            if (!created) {
              skipped.push("product_cat");
              parent = 0;
              break;
            }
            id = created.id;
            categories.set(key, id);
          }
          parent = id;
        }
      }
    } catch {
      skipped.push("product_cat");
    }
  }

  // ---- global attributes (pa_brand, pa_gender) ----
  const enabled = (key: "brand" | "gender") =>
    key === "brand" ? taxonomy.write.brandAttribute : taxonomy.write.genderAttribute;
  const needed = IDENTITY_ATTRIBUTES.filter(
    (a) => enabled(a.key) && wanted.some((w) => (a.key === "brand" ? w.brand : w.gender)),
  );
  if (needed.length > 0) {
    try {
      const taxonomies = await client.getAttributeTaxonomies();
      for (const attr of needed) {
        let id = taxonomies.find((t) => t.slug === attr.slug || attr.match.test(t.slug) || attr.match.test(t.name))?.id;
        if (id == null) {
          // Woo derives the pa_ prefix itself: send the bare slug.
          const created = await client.createAttribute(attr.name, attr.slug.replace(/^pa_/, ""));
          if (!created) {
            skipped.push(attr.slug);
            continue;
          }
          id = created.id;
        }
        attributeIds.set(attr.key, id);

        const values = [
          ...new Map(
            wanted
              .map((w) => (attr.key === "brand" ? w.brand : w.gender))
              .filter((v) => v)
              .map((v) => [termKey(v), v]),
          ).values(),
        ];
        const terms = new Map<string, number>();
        for (const t of await client.listAttributeTerms(id)) terms.set(termKey(t.name), t.id);
        for (const value of values) {
          if (terms.has(termKey(value))) continue;
          const created = await client.createAttributeTerm(id, value);
          if (created) terms.set(termKey(created.name), created.id);
          else {
            skipped.push(`${attr.slug} terms`);
            break;
          }
        }
        attributeTerms.set(attr.key, terms);
      }
    } catch {
      for (const attr of needed) skipped.push(attr.slug);
    }
  }

  return {
    skipped: [...new Set(skipped)],
    for(catalog: SourceProduct): ResolvedIdentity {
      const names = identityNamesFor(catalog, taxonomy);
      const out: ResolvedIdentity = {};

      const brandId = names.brand ? brands.get(termKey(names.brand)) : undefined;
      if (brandId != null) out.brandId = brandId;

      if (names.categoryPath.length > 0) {
        const ids: number[] = [];
        let parent = 0;
        for (const name of names.categoryPath) {
          const id = categories.get(`${parent}/${termKey(name)}`);
          if (id == null) break;
          ids.push(id);
          parent = id;
        }
        if (ids.length > 0) out.categoryIds = ids;
      }

      const attributes: NonNullable<ResolvedIdentity["attributes"]> = [];
      for (const attr of IDENTITY_ATTRIBUTES) {
        const value = attr.key === "brand" ? names.brand : names.gender;
        const attrId = attributeIds.get(attr.key);
        // The term has to exist: Woo silently drops an unknown option on a
        // taxonomy attribute, which would look like it worked.
        if (!value || attrId == null || !attributeTerms.get(attr.key)?.has(termKey(value))) continue;
        attributes.push({ id: attrId, option: value, field: attr.key });
      }
      if (attributes.length > 0) out.attributes = attributes;

      return out;
    },
  };
}
