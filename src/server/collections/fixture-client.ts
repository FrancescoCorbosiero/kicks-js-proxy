import "server-only";
import { DEMO_BRAND_PARENT, DEMO_TAGS, DEMO_TERM_IDS, DEMO_TERM_NAMES, type DemoProduct } from "@/server/vetrina/fixture-data";
import { demoShop } from "@/server/vetrina/fixture-source";
import type { ProductBatchRow, WooClient, WooIndexProduct } from "@/server/woo/client";

/**
 * The automatic categories on the Vetrina's demo shop (VETRINA_SOURCE=fixture):
 * the few calls the runs make, answered from the demo shop's memory the way
 * WooCommerce answers them. A rule saved in demo mode really moves the demo
 * products, and the demo homepage's rails follow — no site involved, nothing
 * written anywhere, a restart puts everything back.
 */

type Term = { id: number; name: string; slug: string; parent?: number };

interface DemoTerms {
  categories: Term[];
  tags: Term[];
  next: number;
}

// Terms created in demo mode live beside the demo shop, like its other edits.
const g = globalThis as { __vetrinaDemoTerms?: DemoTerms };

function terms(): DemoTerms {
  return (g.__vetrinaDemoTerms ??= {
    categories: Object.entries(DEMO_TERM_IDS)
      .filter(([slug]) => !(slug in DEMO_BRAND_PARENT))
      .map(([slug, id]) => ({ id, slug, name: DEMO_TERM_NAMES[slug] ?? slug, parent: 0 })),
    tags: DEMO_TAGS.map((t) => ({ ...t })),
    next: 900,
  });
}

function brands(): Term[] {
  return Object.entries(DEMO_BRAND_PARENT).map(([slug, parent]) => ({
    id: DEMO_TERM_IDS[slug],
    slug,
    name: DEMO_TERM_NAMES[slug] ?? slug,
    parent: parent ? DEMO_TERM_IDS[parent] : 0,
  }));
}

const slugify = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);

function view(p: DemoProduct): WooIndexProduct {
  const { categories, tags } = terms();
  const brand = brands().find((b) => b.slug === p.brand);
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    type: "variable",
    status: "publish",
    permalink: `https://demo.shop/prodotto/${p.id}`,
    categories: p.categories.flatMap((slug) => categories.filter((c) => c.slug === slug)),
    tags: p.tags.flatMap((slug) => tags.filter((t) => t.slug === slug)),
    brands: brand ? [{ id: brand.id, slug: brand.slug, name: brand.name }] : [],
    attributes: [],
    price: String(p.price),
    on_sale: p.onSale,
    stock_status: p.inStock ? "instock" : "outofstock",
    date_created_gmt: p.created.slice(0, 19),
    date_modified_gmt: gmt(p.modified),
  };
}

/** A stand-in for WooClient, as far as the automatic categories use one. */
export function fixtureClient(): WooClient {
  const client = {
    async getProductIndexPage(opts: { page: number; perPage: number; modifiedAfter?: Date; include?: number[] }) {
      let list = [...demoShop().products];
      if (opts.include) list = list.filter((p) => opts.include!.includes(p.id));
      else if (opts.modifiedAfter) {
        const after = opts.modifiedAfter.getTime();
        list = list.filter((p) => p.modified > after).sort((a, b) => a.modified - b.modified);
      }
      const page = list.slice((opts.page - 1) * opts.perPage, opts.page * opts.perPage);
      return { products: page.map(view), total: list.length, totalPages: Math.ceil(list.length / opts.perPage) };
    },

    async batchUpdateProducts(updates: ({ id: number } & Record<string, unknown>)[]): Promise<ProductBatchRow[]> {
      const shop = demoShop();
      const { categories, tags } = terms();
      return updates.map((u) => {
        const p = shop.byId.get(u.id);
        if (!p) return { id: u.id, product: null, error: "Invalid ID." };
        const ids = (field: string) => ((u[field] as { id: number }[] | undefined) ?? []).map((t) => t.id);
        if (u.categories) p.categories = ids("categories").flatMap((id) => categories.filter((c) => c.id === id).map((c) => c.slug));
        if (u.tags) p.tags = ids("tags").flatMap((id) => tags.filter((t) => t.id === id).map((t) => t.slug));
        // Saved: its modified time moves, as WooCommerce's does.
        p.modified = Math.max(Date.now(), p.modified + 1000);
        return { id: p.id, product: view(p), error: null };
      });
    },

    async listCategories() {
      return terms().categories;
    },
    async listBrands() {
      return brands();
    },
    async listTags() {
      return terms().tags;
    },
    async createTag(name: string) {
      const t = terms();
      const tag = { id: t.next++, name, slug: slugify(name) || `tag-${t.next}` };
      t.tags.push(tag);
      return tag;
    },
    async createCategory(name: string, parent?: number) {
      const t = terms();
      const category = { id: t.next++, name, slug: slugify(name) || `categoria-${t.next}`, parent: parent ?? 0 };
      t.categories.push(category);
      return category;
    },
  };
  return client as unknown as WooClient;
}
