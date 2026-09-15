"use server";

import { z } from "zod";
import { wooConfigured } from "@/server/woo/client";
import { repairProducts, scanRepairCandidates, type RepairOutcome } from "@/server/woo/repair";

function errMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export interface RepairScanResult {
  ok: boolean;
  error?: string;
  wooConfigured: boolean;
  /** SKUs the snapshot already shows as incomplete (no picture). */
  incomplete: string[];
  /** Everything on the store a source could complete — the widest sweep. */
  repairable: string[];
  hasSnapshot: boolean;
}

/** What is worth repairing, without touching the store. */
export async function scanRepairs(): Promise<RepairScanResult> {
  const configured = wooConfigured();
  if (!configured) {
    return { ok: true, wooConfigured: false, incomplete: [], repairable: [], hasSnapshot: false };
  }
  try {
    const scan = await scanRepairCandidates();
    return { ok: true, wooConfigured: true, ...scan };
  } catch (e) {
    return {
      ok: false,
      error: errMessage(e),
      wooConfigured: configured,
      incomplete: [],
      repairable: [],
      hasSnapshot: false,
    };
  }
}

const RepairSchema = z.object({
  // Chunked by the client: each product costs a lookup, a read and a write.
  skus: z.array(z.string().min(1).max(64)).min(1).max(50),
  dryRun: z.boolean(),
  includeGallery: z.boolean().optional(),
});

export interface RepairActionResult {
  ok: boolean;
  error?: string;
  outcome?: RepairOutcome;
}

/**
 * Fill what the given products are missing, from the source that owns them.
 * Additive and idempotent: a dry run shows the exact patch, a live run writes
 * only the fields that are empty.
 */
export async function runRepair(input: unknown): Promise<RepairActionResult> {
  const parsed = RepairSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` };
  }
  try {
    return {
      ok: true,
      outcome: await repairProducts(parsed.data.skus, {
        dryRun: parsed.data.dryRun,
        includeGallery: parsed.data.includeGallery,
      }),
    };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}
