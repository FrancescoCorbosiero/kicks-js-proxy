import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { Plan } from "@core/core-spine";
import { db } from "@/server/db/client";
import { plans } from "@/server/db/schema";
import { summarize, type PlanSummary } from "@/lib/plan";

export interface PlanRef {
  id: string;
  sku: string;
  market: string;
}

/** Load (id, sku, market) for a set of plan ids — enough to rebuild apply targets. */
export async function getPlanRefs(ids: string[]): Promise<PlanRef[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: plans.id, sku: plans.sku, market: plans.market })
    .from(plans)
    .where(inArray(plans.id, ids));
}

/** Persist a generated plan so "Apply" (M2) can reference it by id. */
export async function savePlan(plan: Plan, market: string): Promise<{ id: string; summary: PlanSummary }> {
  const summary = summarize(plan.items);
  const [row] = await db
    .insert(plans)
    .values({
      sku: plan.sku,
      currency: plan.currency,
      market,
      generatedAt: new Date(plan.generatedAt),
      items: plan.items,
      summary,
    })
    .returning({ id: plans.id });
  return { id: row.id, summary };
}

export async function getPlanById(id: string): Promise<Plan | null> {
  const rows = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    sku: r.sku,
    currency: r.currency,
    generatedAt: r.generatedAt.toISOString(),
    items: r.items,
  };
}
