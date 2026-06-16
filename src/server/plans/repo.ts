import "server-only";
import { eq } from "drizzle-orm";
import type { Plan } from "@core/core-spine";
import { db } from "@/server/db/client";
import { plans } from "@/server/db/schema";
import { summarize, type PlanSummary } from "@/lib/plan";

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
