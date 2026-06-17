import { buildPlan, type PlanItem, type SourceProduct, type StorePort } from "@core/core-spine";
import type { AppConfig } from "@core/config";

export interface ApplyTarget {
  product: SourceProduct;
  selected: string[]; // stockxVariantIds the operator chose to apply
}

export interface ApplyOptions {
  dryRun: boolean;
  approved: boolean; // operator confirmed changes above the approval threshold
}

export interface ApplyOutcome {
  products: number;
  updated: number; // prices written (or, in dry-run, that WOULD be written)
  skipped: number; // selected but noop/skip
  heldForApproval: number; // update blocked by requireApprovalAboveDeltaPercent
  createPending: number; // selected "create" rows (need M3 import first)
  failed: { stockxVariantId: string; error: string }[];
}

function deltaPercent(current: number, proposed: number): number {
  if (current === 0) return proposed === 0 ? 0 : Infinity;
  return (Math.abs(proposed - current) / Math.abs(current)) * 100;
}

/**
 * Execute a set of apply targets against the store, one parent product at a time.
 *
 * - Re-resolves mappings and rebuilds the plan per product so we act on the live
 *   store state (idempotent: a second run sees noop and writes nothing).
 * - Honors requireApprovalAboveDeltaPercent: large jumps are held unless approved.
 * - dryRun computes what would change and writes nothing.
 * - Reports per-product progress via onProgress.
 */
export async function executeApply(
  store: StorePort,
  config: AppConfig,
  targets: ApplyTarget[],
  opts: ApplyOptions,
  onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = {
    products: targets.length,
    updated: 0,
    skipped: 0,
    heldForApproval: 0,
    createPending: 0,
    failed: [],
  };
  const threshold = config.apply.requireApprovalAboveDeltaPercent;

  for (let i = 0; i < targets.length; i++) {
    const { product, selected } = targets[i];
    const sel = new Set(selected);
    const mappings = await store.resolveMappings(product);
    const plan = buildPlan(product, config, mappings);

    const writeItems: PlanItem[] = [];
    for (const item of plan.items) {
      if (!sel.has(item.stockxVariantId)) continue;
      if (item.action === "create") {
        outcome.createPending += 1;
        continue;
      }
      if (item.action !== "update") {
        outcome.skipped += 1;
        continue;
      }
      if (
        !opts.approved &&
        threshold > 0 &&
        item.currentPrice != null &&
        item.proposedPrice != null &&
        deltaPercent(item.currentPrice, item.proposedPrice) > threshold
      ) {
        outcome.heldForApproval += 1;
        continue;
      }
      writeItems.push(item);
    }

    if (writeItems.length > 0) {
      if (opts.dryRun) {
        outcome.updated += writeItems.length;
      } else {
        const res = await store.applyPrices({
          sku: plan.sku,
          currency: plan.currency,
          generatedAt: plan.generatedAt,
          items: writeItems,
        });
        outcome.updated += res.updated;
        outcome.failed.push(...res.failed);
      }
    }

    if (onProgress) await onProgress(i + 1, targets.length);
  }

  return outcome;
}
