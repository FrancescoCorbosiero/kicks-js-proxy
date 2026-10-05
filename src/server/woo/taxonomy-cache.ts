import "server-only";
import type { WooClient } from "./client";

/**
 * The store's taxonomy listings — attributes (the size one included), brands,
 * categories, attribute terms — remembered for a few minutes between publish
 * batches.
 *
 * Publishing goes in small batches (Cloudflare drops any request that takes
 * longer than 100 seconds), and every batch needs these lists to resolve its
 * products' identity fields. Read fresh each time, that was half a dozen
 * WooCommerce calls per batch — a WordPress bootstrap each — repeated for
 * every batch of a run, for lists that do not change while it runs. Creating
 * a term drops the list it belongs to, so the next read sees the new term.
 *
 * In-process, like the scheduler's state: one app container per shop.
 */
const TTL_MS = 5 * 60_000;

type Entry = { at: number; value: Promise<unknown> };
const cache = ((globalThis as { __storeHubTaxonomyCache?: Map<string, Entry> }).__storeHubTaxonomyCache ??=
  new Map<string, Entry>());

function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // A failed read is not remembered: the next batch asks again.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

async function thenForget<T>(key: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } finally {
    cache.delete(key);
  }
}

/** The client, with its taxonomy reads remembered (and its term writes dropping them). */
export function withTaxonomyCache(client: WooClient): WooClient {
  return new Proxy(client, {
    get(target, prop) {
      switch (prop) {
        case "getAttributeTaxonomies":
          return () => remember("attributes", () => target.getAttributeTaxonomies());
        case "listBrands":
          return () => remember("brands", () => target.listBrands());
        case "listCategories":
          return () => remember("categories", () => target.listCategories());
        case "listAttributeTerms":
          return (id: number) => remember(`terms:${id}`, () => target.listAttributeTerms(id));
        case "createAttribute":
          return (name: string, slug: string) => thenForget("attributes", () => target.createAttribute(name, slug));
        case "createBrand":
          return (name: string) => thenForget("brands", () => target.createBrand(name));
        case "createCategory":
          return (name: string, parent?: number) =>
            thenForget("categories", () => target.createCategory(name, parent));
        case "createAttributeTerm":
          return (id: number, name: string) => thenForget(`terms:${id}`, () => target.createAttributeTerm(id, name));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
