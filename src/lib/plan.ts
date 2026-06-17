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
  title: string;
  brand: string;
  plan: Plan;
  summary: PlanSummary;
  euSizes: Record<string, string>; // stockxVariantId -> EU size, when known
  exactMatch: boolean; // sku/title exactly matches the search term
}
