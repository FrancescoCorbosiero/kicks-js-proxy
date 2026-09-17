"use server";

import { z } from "zod";
import { wooConfigured } from "@/server/woo/client";
import type { PublishPage, PublishQuery } from "@/lib/publish-page";
import {
  listPublishTargets,
  publishProducts,
  type PublishOutcome,
  type PublishTarget,
} from "@/server/woo/publish";

function errMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export interface PublishPageState extends PublishPage<PublishTarget> {
  wooConfigured: boolean;
  /** False when no store snapshot exists — the delta cannot be trusted yet. */
  hasSnapshot: boolean;
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
  try {
    const page = await listPublishTargets(query);
    return { wooConfigured: configured, ...page };
  } catch {
    return {
      wooConfigured: configured,
      candidates: [],
      counts: EMPTY_COUNTS,
      matched: 0,
      hasSnapshot: false,
    };
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
