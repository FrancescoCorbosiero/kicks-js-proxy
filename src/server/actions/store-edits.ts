"use server";

import { z } from "zod";
import {
  keepStoreEdits as keep,
  loadStoreEdits,
  repriceStoreEdits as reprice,
  type StoreEditsState,
} from "@/server/sync/store-edits";

/**
 * The Sync tab's list of prices changed on WordPress (see sync/store-edits.ts):
 * read it, keep the store's prices, or hand them back to the Hub.
 */

export type StoreEditsResult<T> = { ok: true; data: T } | { ok: false; error: string };

function errorOf(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export async function getStoreEdits(): Promise<StoreEditsResult<StoreEditsState>> {
  try {
    return { ok: true, data: await loadStoreEdits() };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}

/** Some rows, or every open one. */
const Target = z.object({
  ids: z.union([z.literal("all"), z.array(z.number().int().positive()).min(1).max(1000)]),
});

export async function keepStoreEdits(
  input: z.infer<typeof Target>,
): Promise<StoreEditsResult<{ kept: number; notLockable: number; state: StoreEditsState }>> {
  const parsed = Target.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const done = await keep(parsed.data.ids);
    return { ok: true, data: { ...done, state: await loadStoreEdits() } };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}

export async function repriceStoreEdits(
  input: z.infer<typeof Target>,
): Promise<
  StoreEditsResult<{ handed: number; updated: number; failed: number; error: string | null; state: StoreEditsState }>
> {
  const parsed = Target.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const done = await reprice(parsed.data.ids);
    return { ok: true, data: { ...done, state: await loadStoreEdits() } };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}
