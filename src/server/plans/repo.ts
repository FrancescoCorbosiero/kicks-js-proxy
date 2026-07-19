import "server-only";
import { eq, lt } from "drizzle-orm";
import type { Plan } from "@core/core-spine";
import { db } from "@/server/db/client";
import { plans } from "@/server/db/schema";
import { summarize, type PlanSummary } from "@/lib/plan";

/** Plans are per-run scratch data; anything older than this is unreachable. */
const PLAN_RETENTION_DAYS = 7;

/**
 * Delete plan rows older than the retention window. A plan only matters between
 * a preview and its export/apply in the same session, so old rows are dead
 * weight — without this the table grows by one row per product per preview run,
 * forever. Best-effort: called at the start of a preview run.
 */
export async function prunePlans(retentionDays = PLAN_RETENTION_DAYS): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    await db.delete(plans).where(lt(plans.createdAt, cutoff));
  } catch (e) {
    console.warn("[plans] prune skipped:", e instanceof Error ? e.message : String(e));
  }
}

/** Persist a generated plan so the JSON export can reference it by id. */
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
