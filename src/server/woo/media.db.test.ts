import { beforeEach, describe, expect, it } from "vitest";
import type { WooRestProduct } from "./client";

/**
 * Real-SQL tests of the photo queue, against a stand-in store. Opt-in: they
 * need a THROWAWAY Postgres with the migrations applied, and they empty the
 * media_jobs table and the store snapshot. Run with
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…@localhost:…/… REDIS_URL=… npm test
 *
 * Imports are dynamic because the db client validates the environment on load.
 */
const url = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const load = async () => ({
  ...(await import("drizzle-orm")),
  ...(await import("@/server/db/client")),
  ...(await import("@/server/db/schema")),
  ...(await import("@/server/store-json/repo")),
  ...(await import("./media")),
  ...(await import("./publishing")),
});

const httpError = (status: number | undefined, body = "") =>
  Object.assign(new Error(status ? `HTTP ${status} for https://shop/wp-json/wc/v3/products: ${body}` : "Request to https://shop/x failed: timed out"), {
    status,
    body,
  });

interface FakeProduct {
  id: number;
  sku: string;
  status: string;
  images: { id: number; src: string; name: string }[];
  variations: number[];
}

/**
 * The store, as far as the queue can tell: photos are filed under the name
 * sent (or not, with keepNames off), a photo it cannot download fails the
 * whole request, and an answer can be lost — after the change was made, or
 * before.
 */
class FakeStore {
  products = new Map<number, FakeProduct>();
  puts: { id: number; body: Record<string, unknown> }[] = [];
  lose: ("applied" | "dropped")[] = [];
  refuse = new Set<string>();
  keepNames = true;
  delayMs = 0;
  /** Unreachable: every read fails before reaching the store. */
  down = false;
  private nextImageId = 1000;

  add(p: Partial<FakeProduct> & { id: number; sku: string }): FakeProduct {
    const product: FakeProduct = { status: "draft", images: [], variations: [11, 12], ...p };
    this.products.set(p.id, product);
    return product;
  }

  private view(p: FakeProduct): WooRestProduct {
    return structuredClone({ ...p }) as unknown as WooRestProduct;
  }

  findProductsBySku = async (sku: string) => {
    if (this.down) throw httpError(undefined);
    return [...this.products.values()].filter((p) => p.sku === sku).map((p) => this.view(p));
  };

  getProduct = async (id: number) => {
    if (this.down) throw httpError(undefined);
    const p = this.products.get(id);
    return p ? this.view(p) : null;
  };

  getAllVariations = async (id: number) =>
    (this.products.get(id)?.variations ?? []).map((v) => ({ id: v })) as never;

  updateProductOnce = async (id: number, body: Record<string, unknown>) => {
    this.puts.push({ id, body });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const lost = this.lose.shift();
    if (lost === "dropped") throw httpError(undefined);
    const p = this.products.get(id);
    if (!p) throw httpError(404, JSON.stringify({ code: "woocommerce_rest_product_invalid_id", message: "Invalid ID." }));
    const sent = (body.images ?? null) as { id?: number; src?: string; name?: string }[] | null;
    if (sent) {
      // All or nothing, as WooCommerce: one photo it cannot download fails the request.
      for (const img of sent) {
        if (img.id == null && img.src && this.refuse.has(img.src)) {
          throw httpError(
            400,
            JSON.stringify({ code: "woocommerce_product_image_upload_error", message: `Error getting remote image ${img.src}.` }),
          );
        }
      }
      p.images = sent.map((img) =>
        img.id != null
          ? p.images.find((have) => have.id === img.id)!
          : {
              id: this.nextImageId++,
              src: `https://shop/wp-content/uploads/${this.nextImageId}.jpg`,
              name: this.keepNames ? img.name! : `upload-${this.nextImageId}`,
            },
      );
    }
    if (typeof body.status === "string") p.status = body.status;
    if (lost === "applied") throw httpError(524, "<html>A timeout occurred</html>");
    return this.view(p);
  };
}

const U = (n: number) => `https://cdn.gs/shoe-${n}.jpg`;

describe.skipIf(!enabled)("the photo queue (real SQL)", () => {
  beforeEach(async () => {
    const { db, mediaJobs, storeSnapshot, publishing } = await load();
    await db.delete(mediaJobs);
    await db.delete(storeSnapshot);
    publishing.clear();
  });

  /** Make every open job due now: the waits are minutes long. */
  async function due() {
    const { db, mediaJobs, eq } = await load();
    await db.update(mediaJobs).set({ nextAttemptAt: new Date(0) }).where(eq(mediaJobs.status, "pending"));
  }

  async function jobFor(sku: string) {
    const { db, mediaJobs, eq, desc } = await load();
    const [row] = await db.select().from(mediaJobs).where(eq(mediaJobs.sku, sku)).orderBy(desc(mediaJobs.createdAt)).limit(1);
    return row;
  }

  it("puts a hidden product on sale with its main photo, then adds the gallery, one request per photo", async () => {
    const { queueMedia, drainMedia, saveSnapshot, listStoreSkus } = await load();
    await saveSnapshot({ products: [] }, "rest");
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "aaa-1", storeProductId: 1, title: "Shoe", urls: [U(1), U(2), U(3)], publish: true });

    const drain = await drainMedia({ budgetMs: 10_000, concurrency: 2, client: store });
    expect(drain).toEqual({ steps: 3, more: false });
    expect(store.puts).toHaveLength(3);
    expect(store.puts[0].body).toMatchObject({ status: "publish", images: [{ src: U(1), alt: "Shoe" }] });
    expect(store.puts[1].body.status).toBeUndefined();
    const p = store.products.get(1)!;
    expect(p.status).toBe("publish");
    expect(p.images).toHaveLength(3);
    const job = await jobFor("AAA-1");
    expect(job.status).toBe("done");
    expect(job.attached).toBe(3);
    expect(job.lockedUntil).toBeNull();
    // On sale, so in the Hub's copy of the store: the feed cycle syncs it.
    expect((await listStoreSkus()).has("AAA-1")).toBe(true);
  });

  it("looks before sending again when an answer is lost: a photo that landed is not sent twice", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1), U(2)], publish: true });

    store.lose.push("applied");
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    const waiting = await jobFor("AAA-1");
    expect(waiting.status).toBe("pending");
    expect(waiting.attempts).toBe(1);
    expect(waiting.lastError).toContain("no answer");
    expect(waiting.lastError).toContain("HTTP 524");
    expect(waiting.lastError).not.toContain("https://");
    expect(waiting.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    await due();
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.puts).toHaveLength(2); // photo 1 once, photo 2 once
    expect(store.products.get(1)!.images).toHaveLength(2);
    expect((await jobFor("AAA-1")).status).toBe("done");
  });

  it("sends a photo again when the lost request never landed", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1)], publish: true });

    store.lose.push("dropped");
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.products.get(1)!.images).toHaveLength(0);
    await due();
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.puts).toHaveLength(2);
    expect(store.products.get(1)!).toMatchObject({ status: "publish", images: [{ name: expect.stringContaining("AAA-1-1-") }] });
  });

  it("tries a refused photo once more, then goes on: the next one becomes the main photo", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    store.refuse.add(U(1));
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1), U(2), U(3)], publish: true });

    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    const once = await jobFor("AAA-1");
    expect(once.refusals).toEqual({ 0: 1 });
    expect(once.lastError).toContain("photo 1 refused: Error getting remote image");
    expect(store.products.get(1)!.status).toBe("draft");

    await due();
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    const p = store.products.get(1)!;
    expect(p.status).toBe("publish");
    expect(p.images.map((i) => i.name)).toEqual([expect.stringContaining("AAA-1-2-"), expect.stringContaining("AAA-1-3-")]);
    expect((await jobFor("AAA-1")).status).toBe("done");
  });

  it("keeps a product hidden when the store takes none of its photos, and says why", async () => {
    const { queueMedia, drainMedia, getMediaQueueState } = await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    store.refuse.add(U(1));
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1)], publish: true });
    for (let i = 0; i < 3; i++) {
      await due();
      await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    }
    const job = await jobFor("AAA-1");
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("photo 1 refused");
    expect(store.products.get(1)!.status).toBe("draft");

    const state = await getMediaQueueState();
    expect(state.failedTotal).toBe(1);
    expect(state.failed[0]).toMatchObject({ sku: "AAA-1", storeProductId: 1, attached: 0, total: 1 });
  });

  it("files a product with no photo at all, so the tab shows it hidden", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [], publish: true });
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    const job = await jobFor("AAA-1");
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("no photo from the source");
    expect(store.puts).toHaveLength(0);
  });

  it("waits for sizes before putting a product on sale", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    const p = store.add({ id: 1, sku: "AAA-1", variations: [] });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1)], publish: true });
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.puts).toHaveLength(0);
    expect((await jobFor("AAA-1")).lastError).toContain("no sizes");

    p.variations = [11];
    await due();
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(p.status).toBe("publish");
  });

  it("finds by SKU a product filed before its create, and gives up on one never created", async () => {
    const { queueMedia, drainMedia, db, mediaJobs, eq } = await load();
    const store = new FakeStore();
    store.add({ id: 7, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: null, title: "Shoe", urls: [U(1)], publish: true });
    await queueMedia({ sku: "BBB-2", storeProductId: null, title: "Other", urls: [U(2)], publish: true });

    await drainMedia({ budgetMs: 10_000, concurrency: 2, client: store });
    expect(await jobFor("AAA-1")).toMatchObject({ status: "done", storeProductId: 7 });
    expect((await jobFor("BBB-2")).status).toBe("pending"); // not created yet: waits

    await db
      .update(mediaJobs)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000), nextAttemptAt: new Date(0) })
      .where(eq(mediaJobs.sku, "BBB-2"));
    await drainMedia({ budgetMs: 10_000, concurrency: 2, client: store });
    expect(await jobFor("BBB-2")).toMatchObject({ status: "cancelled", lastError: "the product never reached the store" });
  });

  it("stops rather than send a photo twice when the store does not keep its name", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.keepNames = false;
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1), U(2)], publish: true });
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.puts).toHaveLength(1);
    expect(store.products.get(1)!.status).toBe("publish");
    expect((await jobFor("AAA-1")).status).toBe("failed");
  });

  it("leaves alone a SKU being published right now, and puts products off sale first", async () => {
    const { queueMedia, drainMedia, publishing, db, mediaJobs, eq } = await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1", status: "publish" });
    store.add({ id: 2, sku: "BBB-2" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "A", urls: [U(1), U(2)], publish: false });
    await queueMedia({ sku: "BBB-2", storeProductId: 2, title: "B", urls: [U(3)], publish: true });
    // A's gallery already under way: B, still hidden, goes first.
    await db.update(mediaJobs).set({ attached: 1 }).where(eq(mediaJobs.sku, "AAA-1"));

    publishing.add("BBB-2");
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.puts.every((put) => put.id === 1)).toBe(true);
    expect(store.products.get(2)!.status).toBe("draft");

    publishing.delete("BBB-2");
    store.puts = [];
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "A", urls: [U(4), U(5)], publish: false });
    await db.update(mediaJobs).set({ attached: 1 }).where(eq(mediaJobs.sku, "AAA-1"));
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.puts[0].id).toBe(2);
  });

  it("files again over the open job: new photos, and a product waiting to go on sale keeps waiting", async () => {
    const { queueMedia, db, mediaJobs, eq } = await load();
    await queueMedia({ sku: "AAA-1", storeProductId: null, title: "Shoe", urls: [U(1)], publish: true });
    await queueMedia({ sku: "AAA-1", storeProductId: 5, title: "Shoe v2", urls: [U(2), U(3)], publish: false, replace: true });
    const rows = await db.select().from(mediaJobs).where(eq(mediaJobs.sku, "AAA-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ storeProductId: 5, title: "Shoe v2", publish: true, replace: true, status: "pending" });
    expect(rows[0].images.map((i) => i.src)).toEqual([U(2), U(3)]);
  });

  it("never lets two workers send the same job's photos at once", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.delayMs = 30;
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [U(1), U(2), U(3)], publish: true });
    await Promise.all([
      drainMedia({ budgetMs: 10_000, concurrency: 1, client: store }),
      drainMedia({ budgetMs: 10_000, concurrency: 1, client: store }),
    ]);
    expect(store.puts).toHaveLength(3);
    expect(store.products.get(1)!.images).toHaveLength(3);
  });

  it("counts a product hidden until its photos land as published, not as one to publish", async () => {
    const { db, catalogProducts, inArray, saveSnapshot, queueMedia } = await load();
    const { countUnpublishedCandidates } = await import("@/server/catalog/repo");
    const skus = ["ON-1", "NOSIZE-1", "QUEUED-1", "MISSING-1"];
    await db.delete(catalogProducts).where(inArray(catalogProducts.sku, skus));
    await db.insert(catalogProducts).values(
      skus.map((sku) => ({
        market: "ZZ",
        sku,
        stockxId: sku,
        data: {} as never,
        variantCount: 3,
        source: "goldensneakers" as const,
      })),
    );
    await saveSnapshot(
      {
        products: [
          { id: 1, sku: "ON-1", variations: [{ id: 5 }] },
          { id: 2, sku: "NOSIZE-1", variations: [] },
        ],
      } as never,
      "rest",
    );
    await queueMedia({ sku: "QUEUED-1", storeProductId: 3, title: "Q", urls: [U(1)], publish: true });
    // Queued, but the copy has it without sizes: still one to publish (to complete).
    await queueMedia({ sku: "NOSIZE-1", storeProductId: 2, title: "N", urls: [U(1)], publish: true });

    expect(await countUnpublishedCandidates("ZZ")).toBe(2); // NOSIZE-1 and MISSING-1
    await db.delete(catalogProducts).where(inArray(catalogProducts.sku, skus));
  });

  it("waits out a store that does not answer, without spending the products' tries", async () => {
    const { queueMedia, drainMedia } = await load();
    const store = new FakeStore();
    store.down = true;
    for (const [i, sku] of ["AAA-1", "BBB-2", "CCC-3"].entries()) {
      store.add({ id: i + 1, sku });
      await queueMedia({ sku, storeProductId: i + 1, title: sku, urls: [U(i)], publish: true });
    }
    const drain = await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    // One product asked, then the round stops: the others would hear the same.
    expect(drain).toEqual({ steps: 1, more: false, unreachable: "timed out" });
    const asked = await jobFor("AAA-1");
    expect(asked).toMatchObject({ status: "pending", attempts: 0, lastError: "the store did not answer: timed out" });
    expect(asked.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect((await jobFor("BBB-2")).lastError).toBeNull();

    // A few hours of it: still nobody's tries spent, and back to work when it answers.
    for (let i = 0; i < 10; i++) {
      await due();
      await drainMedia({ budgetMs: 10_000, concurrency: 3, client: store });
    }
    for (const sku of ["AAA-1", "BBB-2", "CCC-3"]) expect(await jobFor(sku)).toMatchObject({ status: "pending", attempts: 0 });
    store.down = false;
    await due();
    await drainMedia({ budgetMs: 10_000, concurrency: 3, client: store });
    for (const sku of ["AAA-1", "BBB-2", "CCC-3"]) expect((await jobFor(sku)).status).toBe("done");
  });

  it("puts failed jobs back in the queue, or off the list", async () => {
    const { queueMedia, drainMedia, retryFailedMedia, dismissFailedMedia, getMediaQueueState, setMediaProduct, dropMedia } =
      await load();
    const store = new FakeStore();
    store.add({ id: 1, sku: "AAA-1" });
    await queueMedia({ sku: "AAA-1", storeProductId: 1, title: "Shoe", urls: [], publish: true });
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect((await getMediaQueueState()).failedTotal).toBe(1);

    // A photo added by hand meanwhile: the retry finds it and puts the product on sale.
    store.products.get(1)!.images = [{ id: 5, src: "https://shop/mine.jpg", name: "my own shot" }];
    expect(await retryFailedMedia()).toBe(1);
    expect(await getMediaQueueState()).toMatchObject({ hidden: 1, failedTotal: 0 });
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(store.products.get(1)!.status).toBe("publish");
    expect(store.products.get(1)!.images).toHaveLength(1);
    expect((await jobFor("AAA-1")).status).toBe("done");

    // dismiss
    store.add({ id: 2, sku: "BBB-2" });
    await queueMedia({ sku: "BBB-2", storeProductId: 2, title: "B", urls: [], publish: true });
    await drainMedia({ budgetMs: 10_000, concurrency: 1, client: store });
    expect(await dismissFailedMedia()).toBe(1);
    expect((await getMediaQueueState()).failedTotal).toBe(0);

    // the create bookkeeping: an id once it exists, cancelled when it never will
    await queueMedia({ sku: "CCC-3", storeProductId: null, title: "C", urls: [U(1)], publish: true });
    await setMediaProduct("ccc-3", 9);
    expect((await jobFor("CCC-3")).storeProductId).toBe(9);
    await dropMedia("CCC-3");
    expect((await jobFor("CCC-3")).status).toBe("pending"); // it has a product: not this create's to drop
    await queueMedia({ sku: "DDD-4", storeProductId: null, title: "D", urls: [U(1)], publish: true });
    await dropMedia("DDD-4");
    expect((await jobFor("DDD-4")).status).toBe("cancelled");
  });
});
