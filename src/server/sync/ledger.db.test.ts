import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real-SQL tests of prices changed on the store: the ledger the writes keep,
 * the plan that holds an edit, the live check before an unattended write, and
 * the list's two answers — against a stand-in store. Opt-in: they need a
 * THROWAWAY Postgres with the migrations applied, and they empty the feed, the
 * ledger, the overrides and the snapshot. Run with
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…@localhost:…/… REDIS_URL=… npm test
 *
 * (without KICKS_SECRET: the products here are the GoldenSneakers feed's).
 * Imports are dynamic because the db client validates the environment on load.
 */
const url = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1)[:/]/.test(url);

interface FakeVariation {
  id: number;
  sku: string;
  regular_price: string;
  manage_stock: boolean;
  stock_quantity: number;
  attributes: { attribute_pa_taglia: string };
}

/** The store, as far as the apply can tell: sizes per product, batches applied or refused. */
const store = vi.hoisted(() => ({
  products: new Map<number, FakeVariation[]>(),
  reads: 0,
  refuse: new Set<number>(),
}));

vi.mock("@/server/woo/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/woo/client")>();
  const client = {
    getAllVariations: async (productId: number) => {
      store.reads += 1;
      return structuredClone(store.products.get(productId) ?? []);
    },
    batchVariations: async (productId: number, payload: { update?: Record<string, unknown>[] }) => {
      const sizes = store.products.get(productId) ?? [];
      const update = (payload.update ?? []).map((row) => {
        const id = row.id as number;
        if (store.refuse.has(id)) return { id, error: { code: "invalid", message: "refused by the store" } };
        const v = sizes.find((s) => s.id === id);
        if (!v) return { id, error: { code: "woocommerce_rest_invalid_id", message: "Invalid ID." } };
        if (row.regular_price != null) v.regular_price = String(row.regular_price);
        if (row.stock_quantity != null) v.stock_quantity = Number(row.stock_quantity);
        return { id };
      });
      return { create: [], update, delete: [] };
    },
    updateProduct: async () => undefined,
  };
  return { ...real, wooConfigured: () => true, getWooClient: () => client };
});

const load = async () => ({
  ...(await import("drizzle-orm")),
  ...(await import("@/server/db/client")),
  ...(await import("@/server/db/schema")),
  ...(await import("@/server/store-json/repo")),
  ...(await import("@/server/overrides/repo")),
  ...(await import("./ledger")),
  ...(await import("./price-sync")),
  ...(await import("./store-edits")),
  ...(await import("@/server/actions/overrides")),
});

const SKU = "LEDGER-1";
const size = (id: number, eu: string, price: string, qty: number): FakeVariation => ({
  id,
  sku: `${SKU}-${eu}`,
  regular_price: price,
  manage_stock: true,
  stock_quantity: qty,
  attributes: { attribute_pa_taglia: eu },
});
const feedRow = (eu: string, presentedPrice: number, quantity: number) => ({
  feed: "goldensneakers",
  sku: SKU,
  euNorm: eu,
  sizeLabel: eu,
  quantity,
  active: true,
  presentedPrice,
  offerPrice: 80,
  productName: "Ledger Low",
  brandName: "B",
});

describe.skipIf(!enabled)("prices changed on the store (real SQL, stand-in store)", () => {
  beforeEach(async () => {
    const { db, feedItems, priceLedger, storeOverrides, saveSnapshot } = await load();
    await db.delete(feedItems);
    await db.delete(priceLedger);
    await db.delete(storeOverrides);
    store.products.set(1, [size(11, "42", "120.00", 2), size(12, "43", "120.00", 2)]);
    store.reads = 0;
    store.refuse.clear();
    await saveSnapshot({ products: [{ id: 1, sku: SKU, name: "Ledger Low", variations: structuredClone(store.products.get(1)) }] } as never, "rest");
    await db.insert(feedItems).values([feedRow("42", 130, 2), feedRow("43", 130, 2)]);
  });

  const setFeedPrice = async (price: number) => {
    const { db, feedItems, eq } = await load();
    await db.update(feedItems).set({ presentedPrice: price }).where(eq(feedItems.sku, SKU));
  };
  const ledgerRow = async (variationId: number) => {
    const { db, priceLedger, eq } = await load();
    return (await db.select().from(priceLedger).where(eq(priceLedger.variationId, variationId)))[0] ?? null;
  };
  const storePrice = (variationId: number) => store.products.get(1)!.find((v) => v.id === variationId)!.regular_price;

  it("records what it writes, keeps an edit made since, and never writes over it", async () => {
    const { runPriceSync, listStoreEdits, getSnapshotProductsByIds } = await load();

    // 1. First write: nothing on record yet — the Hub takes the prices over.
    const first = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(first.outcome?.updated).toBe(2);
    expect(storePrice(11)).toBe("130.00");
    expect((await ledgerRow(11))).toMatchObject({ price: 130, storePrice: null, euSize: "42", sku: SKU });

    // 2. Someone changes size 42 in WordPress; the feed then moves to 135.
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "149.99";
    await setFeedPrice(135);
    const second = await runPriceSync({ skus: [SKU], liveCheck: true });
    // The plan (from the snapshot) wanted both; the live check kept 42.
    expect(second.outcome?.updated).toBe(1);
    expect(second.outcome?.keptStoreEdits).toBe(1);
    expect(storePrice(11)).toBe("149.99");
    expect(storePrice(12)).toBe("135.00");
    expect(await ledgerRow(11)).toMatchObject({ price: 130, storePrice: 149.99 });
    // The snapshot learned the edit from the store's own answer.
    const [snap] = await getSnapshotProductsByIds([1]);
    expect(snap.variations.find((v) => v.id === 11)?.regular_price).toBe("149.99");

    // 3. The next run sees the edit in the snapshot: the plan holds it, nothing to write.
    const third = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(third.outcome).toBeNull();
    expect(third.report.totals?.skip).toBe(1);
    expect(storePrice(11)).toBe("149.99");

    const { rows, total } = await listStoreEdits();
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ variationId: 11, storePrice: 149.99, price: 130, title: "Ledger Low", sizeLabel: "42" });
  });

  it("keep: the store's price is locked, and from then on it is the one the sync writes", async () => {
    const { runPriceSync, keepStoreEdits, getOverrides, countStoreEdits } = await load();
    await runPriceSync({ skus: [SKU], liveCheck: true });
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "149.99";
    await setFeedPrice(135);
    await runPriceSync({ skus: [SKU], liveCheck: true });

    expect(await keepStoreEdits("all")).toEqual({ kept: 1, notLockable: 0 });
    expect((await getOverrides()).variations[`${SKU}::42`]).toEqual({ manualPrice: 149.99 });
    expect(await countStoreEdits()).toBe(0);
    expect(await ledgerRow(11)).toMatchObject({ price: 149.99, storePrice: null });

    const after = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(after.outcome).toBeNull(); // the lock is what the store shows: nothing to write
    expect(storePrice(11)).toBe("149.99");
  });

  it("use the Hub's price: the rules price the size again, written at once", async () => {
    const { runPriceSync, repriceStoreEdits, countStoreEdits } = await load();
    await runPriceSync({ skus: [SKU], liveCheck: true });
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "149.99";
    await setFeedPrice(135);
    await runPriceSync({ skus: [SKU], liveCheck: true });

    const done = await repriceStoreEdits([11]);
    expect(done).toMatchObject({ handed: 1, updated: 1, failed: 0, error: null });
    expect(storePrice(11)).toBe("135.00");
    expect(await countStoreEdits()).toBe(0);
    expect(await ledgerRow(11)).toMatchObject({ price: 135, storePrice: null });
  });

  it("a lock set in the Hub after the edit is the newer word, and is written", async () => {
    const { runPriceSync, setVariationManualPrice, countStoreEdits } = await load();
    await runPriceSync({ skus: [SKU], liveCheck: true });
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "149.99";
    await setFeedPrice(135);
    await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(await countStoreEdits()).toBe(1);

    expect((await setVariationManualPrice({ parentSku: SKU, euSize: "42", price: 140 })).ok).toBe(true);
    expect(await countStoreEdits()).toBe(0);
    const after = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(after.outcome?.updated).toBe(1);
    expect(storePrice(11)).toBe("140.00");
  });

  it("an edit undone on the store leaves the list by itself", async () => {
    const { runPriceSync, countStoreEdits } = await load();
    await runPriceSync({ skus: [SKU], liveCheck: true });
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "149.99";
    await setFeedPrice(135);
    await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(await countStoreEdits()).toBe(1);

    // Put back in WordPress: the next write's live read refreshes the snapshot…
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "130.00";
    await setFeedPrice(200);
    const after = await runPriceSync({ skus: [SKU], liveCheck: true });
    // …the plan still saw the edit (snapshot), so 42 waits one run, 43 is written.
    expect(storePrice(12)).toBe("200.00");
    expect(after.outcome?.updated).toBe(1);
    // The run after reads the refreshed snapshot: back in step, written, off the list.
    const next = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(next.outcome?.updated).toBe(1);
    expect(storePrice(11)).toBe("200.00");
    expect(await countStoreEdits()).toBe(0);
  });

  it("a size already at the Hub's price is watched from its first plan, never written or not", async () => {
    const { runPriceSync, saveSnapshot, countStoreEdits } = await load();
    await setFeedPrice(120); // the store already shows the feed's price: nothing to write
    const first = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(first.outcome).toBeNull();
    expect(await ledgerRow(11)).toMatchObject({ price: 120, storePrice: null, euSize: "42" });

    // Changed in WordPress, then read by a pull; the feed moves on.
    store.products.get(1)!.find((v) => v.id === 11)!.regular_price = "149.99";
    await saveSnapshot({ products: [{ id: 1, sku: SKU, name: "Ledger Low", variations: structuredClone(store.products.get(1)) }] } as never, "rest");
    await setFeedPrice(135);
    const next = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(next.outcome?.updated).toBe(1); // 43 only
    expect(storePrice(11)).toBe("149.99");
    expect(storePrice(12)).toBe("135.00");
    expect(await countStoreEdits()).toBe(1);
  });

  it("a full pull forgets deleted sizes and closes the edits of products it no longer brings", async () => {
    const { db, priceLedger, saveSnapshot, pruneLedgerToSnapshot, noteStoreEdits, recordPriceWrites } = await load();
    await recordPriceWrites([
      { variationId: 11, productId: 1, sku: SKU, euSize: "42", price: 130 },
      { variationId: 19, productId: 1, sku: SKU, euSize: "44", price: 130 }, // deleted in WordPress
      { variationId: 21, productId: 2, sku: "GONE-1", euSize: "42", price: 90 },
    ]);
    await noteStoreEdits([{ variationId: 21, productId: 2, sku: "GONE-1", euSize: "42", storePrice: 99, hubPrice: 90 }]);
    // The pull brought product 1 (sizes 11 and 12) and not product 2 (unpublished).
    await saveSnapshot({ products: [{ id: 1, sku: SKU, name: "Ledger Low", variations: structuredClone(store.products.get(1)) }] } as never, "rest");

    await pruneLedgerToSnapshot();
    const rows = await db.select().from(priceLedger);
    expect(rows.map((r) => r.variationId).sort()).toEqual([11, 21]);
    expect(rows.find((r) => r.variationId === 21)).toMatchObject({ price: 90, storePrice: null });
  });

  it("a row the store refuses is a failure, and is not recorded as written", async () => {
    const { runPriceSync } = await load();
    store.refuse.add(12);
    const run = await runPriceSync({ skus: [SKU], liveCheck: true });
    expect(run.outcome?.updated).toBe(1);
    expect(run.outcome?.failedTotal).toBe(1);
    expect(run.outcome?.failed[0].error).toBe("refused by the store");
    expect(await ledgerRow(12)).toBeNull();
    expect(storePrice(12)).toBe("120.00");
  });
});
