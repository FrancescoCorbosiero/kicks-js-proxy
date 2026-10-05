"use server";

import { z } from "zod";
import { wooConfigured } from "@/server/woo/client";
import type { PublishPage, PublishQuery } from "@/lib/publish-page";
import {
  listPublishTargetSkus,
  listPublishTargets,
  publishProducts,
  type PublishOutcome,
  type PublishTarget,
} from "@/server/woo/publish";
import {
  dismissFailedMedia,
  getMediaQueueState,
  retryFailedMedia,
  type MediaQueueState,
} from "@/server/woo/media";

function errMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export interface PublishPageState extends PublishPage<PublishTarget> {
  wooConfigured: boolean;
  /** False when no store snapshot exists — the delta cannot be trusted yet. */
  hasSnapshot: boolean;
  /** The photo queue (null when it cannot be read). */
  media: MediaQueueState | null;
  /** The in-app scheduler is on, so something works the queue. */
  mediaWorker: boolean;
}

const EMPTY_COUNTS = { all: 0, goldensneakers: 0, kicksdb: 0, missing: 0, total: 0 };

/**
 * A page of the Publish tab's list, resolved against the current filters.
 *
 * The filters live in the URL and are answered here, so the browser never
 * receives more than one page of candidates however large the delta is.
 */
export async function getPublishState(query: PublishQuery = {}): Promise<PublishPageState> {
  const configured = wooConfigured();
  const { getSchedulerStatus } = await import("@/server/scheduler");
  const media = await getMediaQueueState().catch(() => null);
  const mediaWorker = getSchedulerStatus().enabled;
  try {
    const page = await listPublishTargets(query);
    return { wooConfigured: configured, ...page, media, mediaWorker };
  } catch {
    return {
      wooConfigured: configured,
      candidates: [],
      counts: EMPTY_COUNTS,
      matched: 0,
      hasSnapshot: false,
      media,
      mediaWorker,
    };
  }
}

/** The photo queue, for the Publish tab's panel while photos are on their way. */
export async function getPhotoQueue(): Promise<{ ok: true; media: MediaQueueState } | { ok: false; error: string }> {
  try {
    return { ok: true, media: await getMediaQueueState() };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

/** Put the failed photo jobs back in the queue (or, with dismiss, off the list). */
export async function resolveFailedPhotos(
  input: unknown,
): Promise<{ ok: true; count: number; media: MediaQueueState } | { ok: false; error: string }> {
  const parsed = z.object({ action: z.enum(["retry", "dismiss"]) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const count = parsed.data.action === "retry" ? await retryFailedMedia() : await dismissFailedMedia();
    return { ok: true, count, media: await getMediaQueueState() };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

const SkusQuerySchema = z.object({
  q: z.string().max(200).optional(),
  source: z.enum(["all", "goldensneakers", "kicksdb"]).optional(),
  showOnStore: z.boolean().optional(),
});

/** Every SKU the tab's filters match, for "select all" — past the rendered page too. */
export async function listPublishSkus(
  input: unknown,
): Promise<{ ok: true; skus: string[] } | { ok: false; error: string }> {
  const parsed = SkusQuerySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    return { ok: true, skus: await listPublishTargetSkus(parsed.data) };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

const PublishSchema = z.object({
  // A publish run writes one product per SKU; keep batches reviewable.
  skus: z.array(z.string().min(1).max(64)).min(1).max(200),
  dryRun: z.boolean(),
  includeGallery: z.boolean().optional(),
  force: z.boolean().optional(),
  replaceMedia: z.boolean().optional(),
});

export interface PublishActionResult {
  ok: boolean;
  error?: string;
  outcome?: PublishOutcome;
}

/**
 * Create (or force-reimport) the selected catalog products on WooCommerce.
 * Dry-run computes and reports the exact payloads without writing anything.
 */
export async function runPublish(input: unknown): Promise<PublishActionResult> {
  const parsed = PublishSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` };
  }
  try {
    const outcome = await publishProducts(parsed.data.skus, {
      dryRun: parsed.data.dryRun,
      includeGallery: parsed.data.includeGallery,
      force: parsed.data.force,
      replaceMedia: parsed.data.replaceMedia,
    });
    return { ok: true, outcome };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}
