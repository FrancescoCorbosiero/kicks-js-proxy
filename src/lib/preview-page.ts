import type { PlanSummary, PreviewPlan } from "./plan";

/**
 * The page of a preview run the browser is sent.
 *
 * A whole-store preview produces one plan per product and the store has no
 * ceiling, so what crosses the wire has to have one: 20 000 plans with their
 * items serialize to a 110 MB server-action response, and building it took the
 * dev server past its 4 GB heap and killed it mid-sync. The rest of the run is
 * not lost — it is persisted under a run id, counted, and applied.
 *
 * Pure on purpose, like the Publish tab's pager: the bound is the whole point,
 * so it is covered by tests rather than by good intentions.
 */

/** Plans shipped to the browser. Beyond this, the run is summarized, not sent. */
export const PREVIEW_PAGE_LIMIT = 300;

/** How much a product has to say for itself — what ordering protects. */
export function previewWeight(p: { summary: PlanSummary }): number {
  return p.summary.update + p.summary.create;
}

/**
 * Collects the best N plans of a run without ever holding all of them.
 *
 * "Best" is most-to-do first, so what falls off the end is always the long
 * thin tail of products with nothing actionable — never the work the operator
 * opened the tab to review. Ties break on SKU so a run is reproducible.
 */
export class PreviewPage<T extends { sku: string; summary: PlanSummary }> {
  private rows: T[] = [];

  constructor(private readonly limit: number = PREVIEW_PAGE_LIMIT) {}

  add(plans: readonly T[]): void {
    for (const p of plans) this.rows.push(p);
    // Compacted lazily — once per chunk, not once per plan. The slack keeps
    // this from degenerating into a sort per insert on a long run.
    if (this.rows.length > this.limit * 2) this.compact();
  }

  private compact(): void {
    this.rows.sort(
      (a, b) => previewWeight(b) - previewWeight(a) || a.sku.localeCompare(b.sku),
    );
    this.rows.length = Math.min(this.rows.length, this.limit);
  }

  take(): T[] {
    this.compact();
    return this.rows;
  }
}

/** Convenience for the common case: page a run that is already in hand. */
export function pagePreviewPlans(
  plans: readonly PreviewPlan[],
  limit = PREVIEW_PAGE_LIMIT,
): PreviewPlan[] {
  const page = new PreviewPage<PreviewPlan>(limit);
  page.add(plans);
  return page.take();
}
