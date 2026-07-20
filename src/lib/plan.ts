import type { Plan, PlanAction, PlanItem } from "@core/core-spine";

export type PlanSummary = Record<PlanAction, number>;

/** Only update/create rows can be applied; noop/skip are informational. */
export function isActionable(action: PlanAction): boolean {
  return action === "update" || action === "create";
}

export function emptySummary(): PlanSummary {
  return { update: 0, create: 0, noop: 0, skip: 0 };
}

/** Count items per action. Used for the preview summary and per-selection counts. */
export function summarize(items: Pick<PlanItem, "action">[]): PlanSummary {
  const s = emptySummary();
  for (const i of items) s[i.action] += 1;
  return s;
}

/** A plan plus its persisted id, as returned to the client by the preview action. */
export interface PreviewPlan {
  planId: string;
  market: string;
  sku: string; // parent SKU — the stable key for product/variation overrides
  title: string;
  brand: string;
  /** Who owns this product: "kicksdb" or a feed name (e.g. "goldensneakers"). */
  source: string;
  plan: Plan;
  summary: PlanSummary;
  euSizes: Record<string, string>; // stockxVariantId -> EU size, when known
  exactMatch: boolean; // sku/title exactly matches the search term
  followSaleRule: boolean; // product-level: preserve manual sale prices (default true)
  manualPrices: Record<string, number>; // stockxVariantId -> operator-locked price
}
