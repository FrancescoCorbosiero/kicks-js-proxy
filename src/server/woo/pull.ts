import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { countOf } from "@/server/db/rows";
import { storePullRuns, storePullProducts, type StorePullRunRow } from "@/server/db/schema";
import { saveSnapshot } from "@/server/store-json/repo";
import type { StoreModel, StoreProductModel } from "@/server/store-json/model";
import { registerWooCatalogEntries } from "@/server/catalog/woo-register";
import { getWooClient, wooSiteUrl, type WooRestProduct, type WooRestVariation } from "./client";

/**
 * The resumable Woo REST store pull.
 *
 * A store with thousands of products can't be pulled in one server-action
 * timeout, so the pull is cursor-driven: `startPull` opens (or resumes) a run,
 * and each `advancePull` call fetches a bounded slice — one page of parent
 * products plus all their variations — staging results in store_pull_products.
 * The client (or the cron route) keeps calling advance until `done`; the last
 * advance assembles the staged rows into the active snapshot (source "rest")
 * and clears the staging area. The cursor lives in the run row, so an
 * interrupted pull resumes exactly where it stopped.
 */

/** Parent products per advance step. Each costs 1 + variations request. */
const PRODUCTS_PER_PAGE = 20;
/** Concurrent variation fetches within a step. */
const VARIATIONS_CONCURRENCY = 5;

export interface PullProgress {
  runId: string;
  status: StorePullRunRow["status"];
  productsFetched: number;
  variationsFetched: number;
  totalProducts: number | null;
  done: boolean;
  error: string | null;
}

function toProgress(run: StorePullRunRow): PullProgress {
  return {
    runId: run.id,
    status: run.status,
    productsFetched: run.productsFetched,
    variationsFetched: run.variationsFetched,
    totalProducts: run.totalProducts,
    done: run.status === "done",
    error: run.error,
  };
}

async function getRun(runId: string): Promise<StorePullRunRow | null> {
  const rows = await db.select().from(storePullRuns).where(eq(storePullRuns.id, runId)).limit(1);
  return rows[0] ?? null;
}

/** The most recent pull run (any status), for the sync page header. */
export async function getLatestPullRun(): Promise<StorePullRunRow | null> {
  const rows = await db.select().from(storePullRuns).orderBy(desc(storePullRuns.startedAt)).limit(1);
  return rows[0] ?? null;
}

/**
 * Open a new pull run — or resume the existing running one (there is never a
 * reason to pull twice concurrently against one store).
 */
export async function startPull(): Promise<{ run: StorePullRunRow; resumed: boolean }> {
  getWooClient(); // throws early with a friendly message when unconfigured
  const running = await db
    .select()
    .from(storePullRuns)
    .where(eq(storePullRuns.status, "running"))
    .orderBy(desc(storePullRuns.startedAt))
    .limit(1);
  if (running[0]) return { run: running[0], resumed: true };

  const [run] = await db.insert(storePullRuns).values({}).returning();
  return { run, resumed: false };
}

/**
 * Trim a Woo REST product + its variations to the store-model shape the
 * matching/plan engine reads (id, sku, name, variations with price/stock/
 * GTIN/pa_taglia). We deliberately do NOT keep the full REST payload: the
 * REST apply patches prices in place, so nothing needs to round-trip.
 */
function toStoreProduct(p: WooRestProduct, variations: WooRestVariation[]): StoreProductModel {
  return {
    id: p.id,
    sku: p.sku ?? "",
    name: p.name ?? null,
    status: p.status ?? null,
    permalink: p.permalink ?? null,
    date_modified: p.date_modified ?? null,
    // First image only (src) — enough for the catalog card of store-only products.
    images: p.images?.[0]?.src ? [{ src: p.images[0].src }] : null,
    // Parent attributes carry the pa_taglia option list the cleanup realigns.
    attributes: p.attributes ?? null,
    variations: variations.map((v) => ({
      id: v.id,
      sku: v.sku ?? null,
      regular_price: v.regular_price ?? null,
      sale_price: v.sale_price ?? null,
      global_unique_id: v.global_unique_id ?? null,
      stock_quantity: v.stock_quantity ?? null,
      manage_stock: v.manage_stock ?? null,
      stock_status: v.stock_status ?? null,
      attributes: v.attributes ?? null,
    })),
  };
}

/** Staged rows for a run — the pull's own evidence that a page moved. */
async function countStaged(runId: string): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from ${storePullProducts} where "run_id" = ${runId}`,
  );
  return countOf(res);
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * Advance a running pull by `pages` product-pages. Returns live progress;
 * `done: true` means the snapshot has been replaced. Any error marks the run
 * failed (a later startPull opens a fresh run; staged rows of the failed run
 * are dropped with it).
 */
export async function advancePull(runId: string, pages = 1): Promise<PullProgress> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown pull run.");
  if (run.status !== "running") return toProgress(run);

  const client = getWooClient();
  let { cursorPage, productsFetched, variationsFetched, totalProducts } = run;

  try {
    for (let i = 0; i < pages; i++) {
      const { products, total } = await client.getProductsPage(cursorPage, PRODUCTS_PER_PAGE);
      if (totalProducts == null && total != null) totalProducts = total;

      // Staged rows are keyed by (run, product), so a page the store already
      // gave us adds nothing. Counting before and after is how this loop knows
      // the cursor actually moved: an install that ignores `?page` answers
      // every page with the first one, and "finished" below — which trusts the
      // store to send a short page — would never come true. The client drives
      // this one call at a time, so that is an endless pull hammering the shop.
      const staged = await countStaged(runId);

      await forEachLimit(products, VARIATIONS_CONCURRENCY, async (p) => {
        const variations = await client.getAllVariations(p.id);
        variationsFetched += variations.length;
        const data = toStoreProduct(p, variations);
        await db
          .insert(storePullProducts)
          .values({ runId, storeProductId: p.id, data })
          .onConflictDoUpdate({
            target: [storePullProducts.runId, storePullProducts.storeProductId],
            set: { data },
          });
      });

      productsFetched += products.length;
      cursorPage += 1;

      const added = (await countStaged(runId)) - staged;
      const repeating = products.length > 0 && added === 0;
      if (repeating) {
        console.warn(
          `[woo] the products endpoint is not paginating — page ${cursorPage - 1} ` +
            `returned ${products.length} products already staged. Finishing the pull ` +
            `with the ${staged} products collected. Check for a cache or security ` +
            `plugin stripping ?page from /products.`,
        );
      }
      const finished = repeating || products.length < PRODUCTS_PER_PAGE;
      await db
        .update(storePullRuns)
        .set({ cursorPage, productsFetched, variationsFetched, totalProducts, updatedAt: new Date() })
        .where(eq(storePullRuns.id, runId));

      if (finished) {
        await completePull(runId);
        return toProgress((await getRun(runId))!);
      }
    }
    return toProgress((await getRun(runId))!);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(storePullRuns)
      .set({ status: "failed", error: message, updatedAt: new Date(), finishedAt: new Date() })
      .where(eq(storePullRuns.id, runId));
    return toProgress((await getRun(runId))!);
  }
}

/** Assemble staged rows into the active snapshot and close the run. */
async function completePull(runId: string): Promise<void> {
  const rows = await db
    .select({ data: storePullProducts.data })
    .from(storePullProducts)
    .where(eq(storePullProducts.runId, runId))
    .orderBy(storePullProducts.storeProductId);

  const products = rows.map((r) => r.data as StoreProductModel);
  const model: StoreModel = {
    format: "woo_rest_pull",
    version: 1,
    site_url: wooSiteUrl() || null,
    product_count: products.length,
    products,
  };
  await saveSnapshot(model, "rest");

  // The catalog mirrors the whole store: register store-only products
  // (source "woo") so the vendor sees ALL inventory, not just feed-covered.
  await registerWooCatalogEntries(model);

  await db.delete(storePullProducts).where(eq(storePullProducts.runId, runId));
  await db
    .update(storePullRuns)
    .set({ status: "done", updatedAt: new Date(), finishedAt: new Date() })
    .where(eq(storePullRuns.id, runId));
}

/** Cancel a running pull and drop its staged rows. */
export async function cancelPull(runId: string): Promise<void> {
  await db.delete(storePullProducts).where(eq(storePullProducts.runId, runId));
  await db
    .update(storePullRuns)
    .set({ status: "cancelled", updatedAt: new Date(), finishedAt: new Date() })
    .where(and(eq(storePullRuns.id, runId), eq(storePullRuns.status, "running")));
}

/**
 * Product pages one invocation will walk. A runaway backstop, not a size
 * limit: at PRODUCTS_PER_PAGE each, this covers 100 000 products. The old
 * ceiling of 1000 steps sat at exactly 20 000 products, so a store that size
 * walked every page, never reached the short page that means "finished", and
 * returned with the snapshot NOT replaced — reported as a plain failure, with
 * nothing saying the work had actually been done and merely needed one more
 * invocation. Hitting a ceiling and hitting an error are different things.
 */
const MAX_PULL_STEPS = 5000;

/**
 * Run a whole pull to completion — the scheduled (cron) entry point.
 *
 * A run is resumable: the cursor lives on the row, so stopping at the ceiling
 * is safe and the next invocation carries on. It is still worth saying out
 * loud, because a snapshot that was not replaced is a store state the operator
 * is reading as current when it is not.
 */
export async function runFullPull(maxSteps = MAX_PULL_STEPS): Promise<PullProgress> {
  const { run } = await startPull();
  let progress = toProgress(run);
  let steps = 0;
  for (; steps < maxSteps && progress.status === "running"; steps++) {
    progress = await advancePull(run.id, 1);
  }
  if (steps >= maxSteps && progress.status === "running") {
    console.warn(
      `[woo] pull ${run.id} stopped at the ${maxSteps}-page ceiling with ` +
        `${progress.productsFetched} products staged. The snapshot was NOT replaced; ` +
        `the run resumes on the next invocation. Raise MAX_PULL_STEPS if the store ` +
        `is genuinely larger than ${maxSteps * PRODUCTS_PER_PAGE} products.`,
    );
  }
  return progress;
}
