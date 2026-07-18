import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { storePullRuns, storePullProducts, type StorePullRunRow } from "@/server/db/schema";
import { saveSnapshot } from "@/server/store-json/repo";
import type { StoreModel, StoreProductModel } from "@/server/store-json/model";
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

      const finished = products.length < PRODUCTS_PER_PAGE;
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
 * Run a whole pull to completion — the scheduled (cron) entry point. Bounded
 * by `maxSteps` as a runaway backstop; each step is one product page.
 */
export async function runFullPull(maxSteps = 1000): Promise<PullProgress> {
  const { run } = await startPull();
  let progress = toProgress(run);
  for (let i = 0; i < maxSteps && progress.status === "running"; i++) {
    progress = await advancePull(run.id, 1);
  }
  return progress;
}
