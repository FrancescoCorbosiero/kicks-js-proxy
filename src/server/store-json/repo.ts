import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { storeSnapshot } from "@/server/db/schema";
import { countOf, rowsOf } from "@/server/db/rows";
import type { StoreModel } from "./model";

/**
 * The snapshot is a single row. Exported because anything querying the blob in
 * SQL must key on the SAME id — a hardcoded guess elsewhere silently matches
 * nothing, and "nothing" is indistinguishable from "the store is empty".
 */
export const SNAPSHOT_ID = "current";
const SINGLETON = SNAPSHOT_ID;

export type SnapshotSource = "upload" | "rest";

export interface SnapshotInfo {
  siteUrl: string | null;
  productCount: number;
  source: SnapshotSource;
  uploadedAt: string;
}

/**
 * Replace the single active store snapshot. `source` records the transport that
 * produced it: "rest" (pulled from the Woo REST API) or "upload" (file fallback).
 */
export async function saveSnapshot(
  model: StoreModel,
  source: SnapshotSource = "upload",
): Promise<void> {
  await db
    .insert(storeSnapshot)
    .values({
      id: SINGLETON,
      siteUrl: model.site_url ?? null,
      productCount: model.products.length,
      source,
      data: model,
    })
    .onConflictDoUpdate({
      target: storeSnapshot.id,
      set: {
        siteUrl: sql`excluded.site_url`,
        productCount: sql`excluded.product_count`,
        source: sql`excluded.source`,
        data: sql`excluded.data`,
        uploadedAt: sql`now()`,
      },
    });
}

export async function getActiveSnapshot(): Promise<StoreModel | null> {
  const rows = await db
    .select()
    .from(storeSnapshot)
    .where(eq(storeSnapshot.id, SINGLETON))
    .limit(1);
  return rows.length ? (rows[0].data as StoreModel) : null;
}

/**
 * Every SKU the store snapshot carries, normalized — extracted IN SQL.
 *
 * The callers that need this need ONLY this: "does the store already have
 * product X". Answering it by deserializing the snapshot pulled the whole blob
 * into the heap — 9.5 MB of JSON for a 3000-product shop, several times that
 * as a live object graph — on every render that asked. The Sync tab asks on
 * every server action, and a store pull fires one per product page, so a long
 * pull turned into hundreds of multi-megabyte allocations racing the collector:
 * "Ineffective mark-compacts near heap limit", and the dev server died.
 *
 * A few thousand short strings instead. Best-effort: an empty set on any error
 * means "the store has nothing", which is what no snapshot already means.
 */
export async function listStoreSkus(): Promise<Set<string>> {
  try {
    const res = await db.execute(sql`
      select distinct upper(trim(p->>'sku')) as sku
      from ${storeSnapshot}, jsonb_array_elements(${storeSnapshot.data}->'products') as p
      where ${storeSnapshot.id} = ${SINGLETON} and coalesce(trim(p->>'sku'), '') <> ''
    `);
    const out = new Set<string>();
    for (const r of rowsOf<{ sku?: string | null }>(res)) if (r.sku) out.add(r.sku);
    return out;
  } catch (e) {
    console.warn("[snapshot] store SKUs skipped:", e instanceof Error ? e.message : e);
    return new Set();
  }
}

/**
 * How many store SKUs appear on MORE than one product — the dashboard's
 * duplicate banner. Computed in SQL over the jsonb so the dashboard never
 * loads the multi-MB snapshot blob. Best-effort: 0 on any error.
 */
export async function countDuplicateSkus(): Promise<number> {
  try {
    const res = await db.execute(sql`
      select count(*)::int as n from (
        select upper(trim(p->>'sku')) as k
        from ${storeSnapshot}, jsonb_array_elements(${storeSnapshot.data}->'products') as p
        where ${storeSnapshot.id} = ${SINGLETON} and coalesce(trim(p->>'sku'), '') <> ''
        group by 1
        having count(*) > 1
      ) g
    `);
    return countOf(res);
  } catch {
    return 0;
  }
}

export async function getSnapshotInfo(): Promise<SnapshotInfo | null> {
  const rows = await db
    .select({
      siteUrl: storeSnapshot.siteUrl,
      productCount: storeSnapshot.productCount,
      source: storeSnapshot.source,
      uploadedAt: storeSnapshot.uploadedAt,
    })
    .from(storeSnapshot)
    .where(eq(storeSnapshot.id, SINGLETON))
    .limit(1);
  if (!rows.length) return null;
  return {
    siteUrl: rows[0].siteUrl,
    productCount: rows[0].productCount,
    source: rows[0].source,
    uploadedAt: rows[0].uploadedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Patching the snapshot without ever holding it                       */
/* ------------------------------------------------------------------ */

/**
 * The snapshot's products for these SKUs, unrolled from the jsonb IN SQL.
 *
 * Every write path — publish, rebuild, apply — needs the handful of products
 * it is about to change, and used to get them by deserializing the entire
 * store: 140 MB of JSON for a 20 000-product shop, several times that as a
 * live object graph. That is per call, and the Publish tab makes one call per
 * batch, back to back.
 */
export async function getSnapshotProductsBySkus(
  skus: string[],
): Promise<Map<string, StoreModel["products"][number]>> {
  const out = new Map<string, StoreModel["products"][number]>();
  if (skus.length === 0) return out;
  const keys = [...new Set(skus.map((s) => s.trim().toUpperCase()))].filter(Boolean);
  if (keys.length === 0) return out;
  try {
    const res = await db.execute(sql`
      select upper(trim(coalesce(p->>'sku', ''))) as key, p as product
      from ${storeSnapshot}, jsonb_array_elements(${storeSnapshot.data}->'products') as p
      where ${storeSnapshot.id} = ${SINGLETON}
        and upper(trim(coalesce(p->>'sku', ''))) in (
          select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)
        )
    `);
    for (const r of rowsOf<{ key: string; product: unknown }>(res)) {
      if (!out.has(r.key)) out.set(r.key, r.product as StoreModel["products"][number]);
    }
    return out;
  } catch (e) {
    console.warn("[snapshot] product read skipped:", e instanceof Error ? e.message : e);
    return out;
  }
}

/**
 * Replace (or append) these products inside the stored snapshot, keyed by
 * canonical SKU, WITHOUT the blob ever entering this process.
 *
 * This is the write half of the same problem. Patching used to mean: read the
 * whole store into memory, map over every product to swap a few, then hand the
 * whole thing back to the driver to re-serialize. On a 20 000-product store
 * that is ~140 MB in and ~140 MB out per call, and publishing a selection is
 * one call per batch — enough churn, next to a dev server's own footprint, to
 * lose the collector and die on "Ineffective mark-compacts near heap limit".
 *
 * Postgres does the swap. What crosses the wire is only the products that
 * actually changed. Best-effort, like the patch it replaces: a snapshot that
 * cannot be updated is stale, never fatal to the write that just succeeded.
 *
 * Returns the resulting product count, or null when there is no snapshot to
 * patch (nothing has been pulled yet — there is no "on the store" to correct).
 */
export async function upsertSnapshotProducts(
  products: StoreModel["products"],
): Promise<number | null> {
  if (products.length === 0) return null;
  try {
    const res = await db.execute(sql`
      with incoming as (
        select p as product, upper(trim(coalesce(p->>'sku', ''))) as key
        from jsonb_array_elements(${JSON.stringify(products)}::jsonb) as p
      ),
      kept as (
        select p as product
        from ${storeSnapshot} s, jsonb_array_elements(s.data->'products') as p
        where s.id = ${SINGLETON}
          and upper(trim(coalesce(p->>'sku', '')))
              not in (select key from incoming where key <> '')
      ),
      merged as (
        select coalesce(jsonb_agg(product), '[]'::jsonb) as arr
        from (select product from kept union all select product from incoming) t
      )
      update ${storeSnapshot} s
      set data = jsonb_set(
                   jsonb_set(s.data, '{products}', m.arr),
                   '{product_count}',
                   to_jsonb(jsonb_array_length(m.arr))
                 ),
          product_count = jsonb_array_length(m.arr),
          uploaded_at = now()
      from merged m
      where s.id = ${SINGLETON}
      returning s.product_count as n
    `);
    const rows = rowsOf<{ n: number | string }>(res);
    if (rows.length === 0) return null; // nothing pulled yet
    return countOf(res);
  } catch (e) {
    console.warn("[snapshot] patch skipped:", e instanceof Error ? e.message : e);
    return null;
  }
}
