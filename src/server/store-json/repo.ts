import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { storeSnapshot } from "@/server/db/schema";
import type { StoreModel } from "./model";

const SINGLETON = "current";

export interface SnapshotInfo {
  siteUrl: string | null;
  productCount: number;
  uploadedAt: string;
}

/** Replace the single active store snapshot. */
export async function saveSnapshot(model: StoreModel): Promise<void> {
  await db
    .insert(storeSnapshot)
    .values({
      id: SINGLETON,
      siteUrl: model.site_url ?? null,
      productCount: model.products.length,
      data: model,
    })
    .onConflictDoUpdate({
      target: storeSnapshot.id,
      set: {
        siteUrl: sql`excluded.site_url`,
        productCount: sql`excluded.product_count`,
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
      uploadedAt: storeSnapshot.uploadedAt,
    })
    .from(storeSnapshot)
    .where(eq(storeSnapshot.id, SINGLETON))
    .limit(1);
  if (!rows.length) return null;
  return {
    siteUrl: rows[0].siteUrl,
    productCount: rows[0].productCount,
    uploadedAt: rows[0].uploadedAt.toISOString(),
  };
}
