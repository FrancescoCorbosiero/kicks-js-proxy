import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { storeSnapshot } from "@/server/db/schema";
import type { StoreModel } from "./model";

const SINGLETON = "current";

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
