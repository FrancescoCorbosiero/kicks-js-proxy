import { beforeEach, describe, expect, it } from "vitest";
import type { CollectionCondition } from "@core/collections";
import type { WooClient, WooIndexProduct } from "@/server/woo/client";

/**
 * Real-SQL tests of the automatic categories' runs, against a stand-in store.
 * Opt-in: they need a THROWAWAY Postgres with the migrations applied, and they
 * empty the smart_collections, store_index and collection_changes tables. Run
 * with
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…@localhost:…/… REDIS_URL=… npm test
 *
 * Imports are dynamic because the db client validates the environment on load.
 */
const url = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const load = async () => ({
  ...(await import("@/server/db/client")),
  ...(await import("@/server/db/schema")),
  ...(await import("./repo")),
  ...(await import("./runner")),
});

interface FakeProduct {
  id: number;
  sku: string;
  name: string;
  status: string;
  categories: number[];
  tags: number[];
  brands: number[];
  attributes: { id: number; name: string; options: string[] }[];
  price: string;
  onSale: boolean;
  stock: string;
  created: number;
  modified: number;
}

type Term = { id: number; name: string; slug: string; parent?: number };

const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/**
 * The store, as far as the runs can tell: a listing that pages by id, honours
 * modified_after (unless told not to) and include; a batch update that saves
 * every product it is given — bumping its modified time, as WooCommerce does —
 * or refuses the ones it is told to.
 */
class FakeStore {
  products = new Map<number, FakeProduct>();
  categories: Term[] = [
    { id: 10, name: "Saldi", slug: "saldi", parent: 0 },
    { id: 11, name: "Saldi Nike", slug: "saldi-nike", parent: 10 },
    { id: 20, name: "Novità", slug: "novita", parent: 0 },
    { id: 30, name: "Sneakers", slug: "sneakers", parent: 0 },
  ];
  tags: Term[] = [{ id: 7, name: "saldi", slug: "saldi" }];
  brands: Term[] = [
    { id: 100, name: "Nike", slug: "nike", parent: 0 },
    { id: 200, name: "Adidas", slug: "adidas", parent: 0 },
  ];
  reads: { page: number; modifiedAfter?: string; include?: number[] }[] = [];
  batches: ({ id: number } & Record<string, unknown>)[][] = [];
  ignoreModifiedAfter = false;
  refuse = new Set<number>();
  clock = Date.parse("2026-10-05T10:00:00Z");
  private nextTerm = 500;

  add(p: Partial<FakeProduct> & { id: number }): FakeProduct {
    const product: FakeProduct = {
      sku: `SKU-${p.id}`,
      name: `Product ${p.id}`,
      status: "publish",
      categories: [30],
      tags: [],
      brands: [100],
      attributes: [],
      price: "129.99",
      onSale: false,
      stock: "instock",
      created: this.clock - 100 * 86_400_000,
      modified: this.clock - 50 * 86_400_000,
      ...p,
    };
    this.products.set(product.id, product);
    return product;
  }

  /** An edit made on the store (WP admin): the product's modified time moves. */
  edit(id: number, change: Partial<FakeProduct>) {
    this.clock += 60_000;
    Object.assign(this.products.get(id)!, change, { modified: this.clock });
  }

  private term(list: Term[], id: number) {
    const t = list.find((x) => x.id === id)!;
    return { id: t.id, name: t.name, slug: t.slug };
  }

  view(p: FakeProduct): WooIndexProduct {
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      type: "variable",
      status: p.status,
      permalink: `https://shop/p/${p.id}`,
      categories: p.categories.map((id) => this.term(this.categories, id)),
      tags: p.tags.map((id) => this.term(this.tags, id)),
      brands: p.brands.map((id) => this.term(this.brands, id)),
      attributes: p.attributes,
      price: p.price,
      on_sale: p.onSale,
      stock_status: p.stock,
      date_created_gmt: gmt(p.created),
      date_modified_gmt: gmt(p.modified),
    };
  }

  getProductIndexPage = async (opts: { page: number; perPage: number; modifiedAfter?: Date; include?: number[] }) => {
    this.reads.push({ page: opts.page, modifiedAfter: opts.modifiedAfter?.toISOString(), include: opts.include });
    let list = [...this.products.values()].filter((p) => p.status !== "trash");
    if (opts.include) list = list.filter((p) => opts.include!.includes(p.id));
    else if (opts.modifiedAfter && !this.ignoreModifiedAfter) {
      list = list.filter((p) => p.modified > opts.modifiedAfter!.getTime()).sort((a, b) => a.modified - b.modified);
    } else list.sort((a, b) => a.id - b.id);
    const slice = list.slice((opts.page - 1) * opts.perPage, opts.page * opts.perPage);
    return { products: slice.map((p) => this.view(p)), total: list.length, totalPages: Math.ceil(list.length / opts.perPage) };
  };

  batchUpdateProducts = async (updates: ({ id: number } & Record<string, unknown>)[]) => {
    this.batches.push(updates);
    return updates.map((u) => {
      const p = this.products.get(u.id);
      if (!p || this.refuse.has(u.id)) return { id: u.id, product: null, error: "Invalid ID." };
      this.clock += 1_000;
      if (u.categories) p.categories = (u.categories as { id: number }[]).map((c) => c.id);
      if (u.tags) p.tags = (u.tags as { id: number }[]).map((t) => t.id);
      p.modified = this.clock;
      return { id: p.id, product: this.view(p), error: null };
    });
  };

  listCategories = async () => this.categories;
  listBrands = async () => this.brands;
  listTags = async () => this.tags;

  createTag = async (name: string) => {
    const tag = { id: this.nextTerm++, name, slug: name.toLowerCase() };
    this.tags.push(tag);
    return tag;
  };

  get client(): WooClient {
    return this as unknown as WooClient;
  }

  /** Product ids directly in a category, as the store has it. */
  membersOf(termId: number): number[] {
    return [...this.products.values()].filter((p) => p.categories.includes(termId)).map((p) => p.id).sort((a, b) => a - b);
  }
}

const TAG_SALDI: CollectionCondition = { field: "tag", op: "is", value: "7", label: "saldi" };

describe.skipIf(!enabled)("the automatic categories' runs (real SQL)", () => {
  beforeEach(async () => {
    const { db, smartCollections, storeIndex, collectionChanges } = await load();
    await db.delete(smartCollections);
    await db.delete(storeIndex);
    await db.delete(collectionChanges);
    delete (globalThis as { __storeHubCollections?: unknown }).__storeHubCollections;
  });

  async function saldi(conditions: CollectionCondition[] = [TAG_SALDI], termId = 10, name = "Saldi") {
    const { insertCollection } = await load();
    return insertCollection({ termId, name, match: "all", conditions, enabled: true });
  }

  it("does nothing at all while no category is automatic — not one request", async () => {
    const { runCheck } = await load();
    const store = new FakeStore();
    expect(await runCheck({ client: store.client })).toBeNull();
    expect(store.reads).toEqual([]);
  });

  it("reads the store whole the first time, then fills and empties the category by the rule", async () => {
    const { runCheck, listChanges, listCollectionRows, readIndex } = await load();
    const store = new FakeStore();
    store.add({ id: 1, tags: [7] }); // joins
    store.add({ id: 2, categories: [10, 30] }); // in Saldi by hand, no tag: leaves
    store.add({ id: 3, categories: [10], tags: [7] }); // stays
    store.add({ id: 4 }); // nothing to do
    const rule = await saldi();

    expect(await runCheck({ client: store.client })).toEqual({ read: 4, moved: 2 });
    expect(store.membersOf(10)).toEqual([1, 3]);
    // Only the categories the rule manages moved: product 2 kept Sneakers.
    expect(store.products.get(2)!.categories).toEqual([30]);
    expect(store.products.get(1)!.categories).toEqual([30, 10]);
    // Every write was preceded by a live read of exactly those products.
    expect(store.reads.at(-1)?.include?.sort()).toEqual([1, 2]);

    const changes = await listChanges();
    expect(changes.map((c) => [c.productId, c.action, c.trigger, c.error]).sort()).toEqual([
      [1, "add", "auto", null],
      [2, "remove", "auto", null],
    ]);
    const [row] = await listCollectionRows();
    expect(row).toMatchObject({ id: rule.id, members: 2, held: null, lastError: null });
    expect(row.lastRunAt).not.toBeNull();
    // The index holds the store as the writes left it.
    const indexed = new Map((await readIndex()).map((p) => [p.id, p]));
    expect(indexed.get(1)!.categories.map((c) => c.id)).toEqual([30, 10]);
  });

  it("then asks only for what changed, and follows a tag added in WP admin", async () => {
    const { runCheck } = await load();
    const store = new FakeStore();
    store.add({ id: 1 });
    store.add({ id: 2 });
    await saldi();
    await runCheck({ client: store.client });
    expect(store.membersOf(10)).toEqual([]);

    store.reads = [];
    store.edit(2, { tags: [7] });
    expect(await runCheck({ client: store.client })).toMatchObject({ moved: 1 });
    expect(store.membersOf(10)).toEqual([2]);
    // A check, not a full read: one listing of what changed, one live re-read.
    expect(store.reads[0].modifiedAfter).toBeDefined();
    expect(store.reads.filter((r) => !r.modifiedAfter && !r.include)).toEqual([]);
  });

  it("writes nothing when the live store already disagrees with a stale index", async () => {
    const { runCheck, upsertIndexRows, readIndex } = await load();
    const store = new FakeStore();
    store.add({ id: 1 });
    await saldi();
    await runCheck({ client: store.client });

    // The index thinks product 1 has the tag (an older read, say)…
    const [row] = await readIndex();
    await upsertIndexRows([{ ...row, tags: [{ id: 7, slug: "saldi", name: "saldi" }], dateModified: null }]);
    store.batches = [];
    // …the store says it does not: re-read live, nothing to write.
    await runCheck({ client: store.client });
    expect(store.batches).toEqual([]);
    expect(store.membersOf(10)).toEqual([]);
  });

  it("never empties a category on its own: the change waits for a confirmation", async () => {
    const { runCheck, applyConfirmed, listCollectionRows } = await load();
    const store = new FakeStore();
    store.add({ id: 1, categories: [10], tags: [7] });
    store.add({ id: 2, categories: [10], tags: [7] });
    const rule = await saldi();
    await runCheck({ client: store.client });

    // The tag disappears from both products (deleted in WP admin).
    store.edit(1, { tags: [] });
    store.edit(2, { tags: [] });
    store.batches = [];
    await runCheck({ client: store.client });
    expect(store.batches).toEqual([]);
    expect(store.membersOf(10)).toEqual([1, 2]);
    let [row] = await listCollectionRows();
    expect(row.held).toEqual({ reason: "empties", joining: 0, leaving: 2 });

    // Confirmed by hand: applied.
    await applyConfirmed([rule.id], { client: store.client });
    expect(store.membersOf(10)).toEqual([]);
    [row] = await listCollectionRows();
    expect(row.held).toBeNull();
    expect(row.members).toBe(0);
  });

  it("holds a change bigger than the limit (COLLECTIONS_MAX_CHANGES, default 200)", async () => {
    const { runCheck, listCollectionRows } = await load();
    const store = new FakeStore();
    for (let id = 1; id <= 201; id++) store.add({ id, tags: [7] });
    await saldi();
    await runCheck({ client: store.client });
    expect(store.membersOf(10)).toEqual([]);
    const [row] = await listCollectionRows();
    expect(row.held).toEqual({ reason: "tooManyChanges", joining: 201, leaving: 0 });
  });

  it("decides a category that reads another one in the same run", async () => {
    const { runCheck } = await load();
    const store = new FakeStore();
    store.add({ id: 1, tags: [7], brands: [100] });
    store.add({ id: 2, tags: [7], brands: [200] });
    // Created first, decided second: "Novità Nike" = in Saldi and brand Nike
    // needs Saldi decided before it, whatever order the rules were saved in.
    await saldi(
      [
        { field: "category", op: "is", value: "10" },
        { field: "brand", op: "is", value: "100" },
      ],
      20,
      "Novità Nike",
    );
    await saldi();
    await runCheck({ client: store.client });
    expect(store.membersOf(10)).toEqual([1, 2]);
    expect(store.membersOf(20)).toEqual([1]);
    // One write per product, carrying both categories at once.
    expect(store.batches.flat().find((u) => u.id === 1)?.categories).toEqual([{ id: 30 }, { id: 10 }, { id: 20 }]);
  });

  it("leaves a sub-category reading its own parent alone: it could never let a product go", async () => {
    const { runCheck, listCollectionRows } = await load();
    const store = new FakeStore();
    store.add({ id: 1, tags: [7] });
    await saldi();
    // "In Saldi" holds for anything in Saldi Nike too: once in, in for good.
    await saldi([{ field: "category", op: "is", value: "10" }], 11, "Saldi Nike");
    await runCheck({ client: store.client });
    expect(store.membersOf(10)).toEqual([1]);
    expect(store.membersOf(11)).toEqual([]);
    const nike = (await listCollectionRows()).find((r) => r.termId === 11);
    expect(nike?.lastError).toBe("loop");
  });

  it("leaves alone a rule whose category is gone from the store, and says so", async () => {
    const { runCheck, listCollectionRows } = await load();
    const store = new FakeStore();
    store.add({ id: 1, tags: [7] });
    await saldi([TAG_SALDI], 999, "Gone");
    await runCheck({ client: store.client });
    expect(store.batches).toEqual([]);
    const [row] = await listCollectionRows();
    expect(row.lastError).toBe("category_missing");
  });

  it("logs a product the store refuses, and lets the automatic runs leave it be for a while", async () => {
    const { runCheck, listChanges, listCollectionRows } = await load();
    const store = new FakeStore();
    store.add({ id: 1, tags: [7] });
    store.add({ id: 2, tags: [7] });
    store.refuse.add(2);
    await saldi();
    await runCheck({ client: store.client });
    expect(store.membersOf(10)).toEqual([1]);
    const refused = (await listChanges()).find((c) => c.productId === 2);
    expect(refused?.error).toBe("Invalid ID.");
    expect((await listCollectionRows())[0].lastError).toBe("Invalid ID.");

    store.batches = [];
    await runCheck({ client: store.client });
    expect(store.batches).toEqual([]);
  });

  it("notices a store that ignores modified_after, and stops asking it", async () => {
    const { runCheck, getRunnerStatus } = await load();
    const store = new FakeStore();
    store.add({ id: 1, modified: store.clock - 86_400_000 });
    store.add({ id: 2, modified: store.clock - 100 * 86_400_000 });
    await saldi();
    await runCheck({ client: store.client });

    store.ignoreModifiedAfter = true;
    store.edit(1, { tags: [7] });
    await runCheck({ client: store.client });
    expect(getRunnerStatus().incremental).toBe(false);
    store.reads = [];
    await runCheck({ client: store.client });
    // No listing at all any more: the daily full read takes over.
    expect(store.reads.filter((r) => !r.include)).toEqual([]);
  });

  it("drops from the index what a full read no longer finds", async () => {
    const { runFull, readIndex } = await load();
    const store = new FakeStore();
    store.add({ id: 1 });
    store.add({ id: 2 });
    await saldi();
    await runFull({ client: store.client });
    expect((await readIndex()).map((p) => p.id)).toEqual([1, 2]);
    store.products.get(2)!.status = "trash";
    await runFull({ client: store.client });
    expect((await readIndex()).map((p) => p.id)).toEqual([1]);
  });

  it("follows a product's tags edited from the Hub at once", async () => {
    const { runCheck, setProductTags, listChanges } = await load();
    const store = new FakeStore();
    store.add({ id: 1 });
    await saldi();
    await runCheck({ client: store.client });

    const edit = await setProductTags(1, [{ id: 7, name: "saldi" }, { name: "estate" }], { client: store.client });
    expect(edit).toMatchObject({ joined: ["Saldi"], left: [], pending: false, error: null });
    expect(edit.tags.map((t) => t.name)).toEqual(["saldi", "estate"]);
    expect(store.membersOf(10)).toEqual([1]);
    expect((await listChanges()).find((c) => c.productId === 1)?.trigger).toBe("product");
  });
});
