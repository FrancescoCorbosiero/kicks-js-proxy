import "server-only";
import { getActiveConfig } from "@/server/config/repo";
import { getStore } from "@/server/adapters/woo";
import { getAnyBySkus } from "@/server/catalog/repo";
import { getPlanRefs } from "@/server/plans/repo";
import { skuKey } from "@/lib/skus";
import { executeApply, type ApplyTarget, type ApplyOutcome } from "./executor";
import { startAudit, finishAudit } from "./audit";
import type { ApplyJobData } from "./types";

/**
 * The apply job body (shared by the BullMQ worker). Rebuilds apply targets from
 * the stored plans + cached source products, runs the executor against Woo, and
 * records an audit row. `onProgress` reports 0..100.
 */
export async function processApplyJob(
  jobId: string,
  data: ApplyJobData,
  onProgress?: (percent: number) => void | Promise<void>,
): Promise<ApplyOutcome> {
  const config = await getActiveConfig();
  const store = getStore(config);

  const refs = await getPlanRefs(data.selections.map((s) => s.planId));
  const selByPlan = new Map(data.selections.map((s) => [s.planId, s.variantIds]));

  const targets: ApplyTarget[] = [];
  const missing: { stockxVariantId: string; error: string }[] = [];
  for (const ref of refs) {
    const products = await getAnyBySkus(ref.market, [ref.sku]);
    const product = products.get(skuKey(ref.sku));
    if (!product) {
      missing.push({ stockxVariantId: ref.sku, error: "product not in catalog — re-run preview" });
      continue;
    }
    targets.push({ product, selected: selByPlan.get(ref.id) ?? [] });
  }

  const auditId = await startAudit(jobId, data.dryRun);

  const outcome = await executeApply(
    store,
    config,
    targets,
    { dryRun: data.dryRun, approved: data.approved },
    (done, total) => onProgress?.(total === 0 ? 100 : Math.round((done / total) * 100)),
  );
  outcome.failed.push(...missing);

  const status = data.dryRun
    ? "dry_run"
    : outcome.failed.length > 0
      ? outcome.updated > 0
        ? "partial"
        : "failed"
      : "applied";

  await finishAudit(auditId, status, outcome.updated, outcome.failed, { ...outcome });
  return outcome;
}
