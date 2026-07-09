import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { storeOverrides } from "@/server/db/schema";
import { emptyOverrides, normalizeOverrides, type StoreOverrides } from "./model";

const SINGLETON = "current";

/**
 * Read the single overrides blob. Best-effort: a DB error (e.g. the table not yet
 * migrated) degrades to "no overrides" rather than breaking the preview.
 */
export async function getOverrides(): Promise<StoreOverrides> {
  try {
    const rows = await db
      .select()
      .from(storeOverrides)
      .where(eq(storeOverrides.id, SINGLETON))
      .limit(1);
    return rows.length ? normalizeOverrides(rows[0].data) : emptyOverrides();
  } catch (e) {
    console.warn("[overrides] read skipped (unavailable):", describeDbError(e));
    return emptyOverrides();
  }
}

/** Replace the single overrides blob. Throws on failure so actions can report it. */
export async function saveOverrides(data: StoreOverrides): Promise<void> {
  await db
    .insert(storeOverrides)
    .values({ id: SINGLETON, data })
    .onConflictDoUpdate({
      target: storeOverrides.id,
      set: { data: sql`excluded.data`, updatedAt: sql`now()` },
    });
}

function describeDbError(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  if (cause?.message) return cause.message;
  return e instanceof Error ? e.message : String(e);
}
