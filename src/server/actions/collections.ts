"use server";

import { z } from "zod";
import { CONDITION_FIELDS, CONDITION_OPS } from "@core/collections";
import type {
  ChangeView,
  CollectionOptions,
  CollectionsState,
  CollectionsStatus,
  DraftCheck,
  ProductTagsResult,
  ProductTagsView,
  TermEditor,
} from "@/lib/collections/types";
import * as service from "@/server/collections/service";

/**
 * The automatic categories' server actions, for the Hub's page and the
 * Vetrina alike: thin, validated wrappers over server/collections. Every one
 * answers { ok, data } or { ok: false, code, error } — the page turns the code
 * into a message.
 */

export type CollectionsResult<T> = { ok: true; data: T } | { ok: false; code: string; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<CollectionsResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof service.CollectionError) return { ok: false, code: e.code, error: e.message };
    return { ok: false, code: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

const invalid = (message = "Invalid request.") => ({ ok: false as const, code: "invalid", error: message });

const ConditionSchema = z.object({
  field: z.enum(CONDITION_FIELDS),
  op: z.enum(CONDITION_OPS),
  value: z.string().max(200),
  attribute: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
});

const DraftSchema = z.object({
  id: z.uuid().optional(),
  termId: z.number().int().positive().optional(),
  newCategory: z
    .object({ name: z.string().trim().min(1).max(120), parent: z.number().int().min(0) })
    .optional(),
  match: z.enum(["all", "any"]),
  conditions: z.array(ConditionSchema).max(20),
  enabled: z.boolean(),
});

const Id = z.object({ id: z.uuid() });

export async function getCollectionsState(): Promise<CollectionsResult<CollectionsState>> {
  return attempt(() => service.loadState());
}

/** The light half of the state, polled while a run is going. */
export async function pollCollections(): Promise<CollectionsResult<CollectionsStatus>> {
  return attempt(() => service.loadStatus());
}

export async function loadCollectionOptions(): Promise<CollectionsResult<CollectionOptions>> {
  return attempt(() => service.loadOptions());
}

/** The rule editor opened on one category — the Vetrina's sheet, from a rail. */
export async function loadCollectionForTerm(input: { termId: number }): Promise<CollectionsResult<TermEditor>> {
  const parsed = z.object({ termId: z.number().int().positive() }).safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(() => service.loadForTerm(parsed.data.termId));
}

/** Opening the editor: bring the store index up to date in the background. */
export async function freshenCollections(): Promise<CollectionsResult<null>> {
  return attempt(async () => {
    await service.freshen();
    return null;
  });
}

export async function checkCollectionDraft(input: unknown): Promise<CollectionsResult<DraftCheck>> {
  const parsed = DraftSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  return attempt(() => service.checkDraft(parsed.data));
}

export async function saveCollectionDraft(input: unknown): Promise<CollectionsResult<{ id: string }>> {
  const parsed = DraftSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  return attempt(async () => ({ id: await service.saveDraft(parsed.data) }));
}

export async function pauseCollection(input: { id: string; paused: boolean }): Promise<CollectionsResult<null>> {
  const parsed = Id.extend({ paused: z.boolean() }).safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(async () => {
    await service.pauseCollection(parsed.data.id, parsed.data.paused);
    return null;
  });
}

export async function deleteCollection(input: { id: string }): Promise<CollectionsResult<null>> {
  const parsed = Id.safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(async () => {
    await service.removeCollection(parsed.data.id);
    return null;
  });
}

/** Apply a change the automatic runs held back for a confirmation. */
export async function confirmCollection(input: { id: string }): Promise<CollectionsResult<null>> {
  const parsed = Id.safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(async () => {
    await service.confirmCollection(parsed.data.id);
    return null;
  });
}

/** Read every product on the store again (in the background), then decide. */
export async function readStoreAgain(): Promise<CollectionsResult<null>> {
  return attempt(async () => {
    await service.readAgain();
    return null;
  });
}

export async function loadCollectionChanges(input: {
  collectionId?: string;
  productId?: number;
}): Promise<CollectionsResult<ChangeView[]>> {
  const parsed = z
    .object({ collectionId: z.uuid().optional(), productId: z.number().int().positive().optional() })
    .safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(() => service.loadChanges({ ...parsed.data, limit: 50 }));
}

const ProductId = z.number().int().positive();

export async function loadProductTags(input: { productId: number }): Promise<CollectionsResult<ProductTagsView>> {
  const parsed = z.object({ productId: ProductId }).safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(() => service.productTags(parsed.data.productId));
}

export async function saveProductTags(input: {
  productId: number;
  tags: { id?: number; name: string }[];
}): Promise<CollectionsResult<ProductTagsResult>> {
  const parsed = z
    .object({
      productId: ProductId,
      tags: z
        .array(z.object({ id: z.number().int().positive().optional(), name: z.string().trim().max(120) }))
        .max(50),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  return attempt(() => service.saveProductTags(parsed.data.productId, parsed.data.tags));
}
