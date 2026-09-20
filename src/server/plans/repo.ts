import "server-only";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Plan } from "@core/core-spine";
import { db } from "@/server/db/client";
import { applyAudit, plans } from "@/server/db/schema";
import { rowsOf } from "@/server/db/rows";
import { summarize, type PlanSummary } from "@/lib/plan";

/**
 * Preview runs kept. A preview SUPERSEDES the one before it — the tab holds
 * exactly one run id — so older runs are dead the moment a new preview lands.
 * Three, not one, so two browser tabs each mid-run cannot delete each other's.
 */
const KEEP_RUNS = 3;

/** Rows per INSERT. A whole-store preview is tens of thousands of plans. */
const INSERT_CHUNK = 250;
/** Plans per SELECT when the apply walks a run. */
const READ_CHUNK = 200;

/**
 * Drop every preview run but the most recent few.
 *
 * A whole-store preview writes ONE ROW PER PRODUCT — 22 000 of them on this
 * shop, with the plan items as jsonb. The retention this replaces was seven
 * DAYS, which is the wrong axis entirely: the rows are scratch between a
 * preview and its apply, and each new preview makes the last one unreachable.
 * Clicking preview eight times left 176 150 rows and 154 MB behind, every one
 * of them dead, and the prune that was supposed to clear them kept them all
 * because none had aged a week. It also scanned the whole table each time,
 * since nothing indexes created_at.
 *
 * Bounded by RUNS now. Rows an audit still points at are never removed, and
 * rows from before runs existed (run_id null) are scratch by definition.
 * Best-effort: called at the start of a preview run.
 */
export async function prunePlans(keepRuns = KEEP_RUNS): Promise<void> {
  try {
    await db.execute(sql`
      delete from ${plans} p
      where not exists (
              select 1 from ${applyAudit} a where a.plan_id = p.id
            )
        and (
              p.run_id is null
              or p.run_id not in (
                   select run_id from ${plans}
                   where run_id is not null
                   group by run_id
                   order by max(created_at) desc
                   limit ${keepRuns}
                 )
            )
    `);
  } catch (e) {
    console.warn("[plans] prune skipped:", e instanceof Error ? e.message : String(e));
  }
}

export interface PlanToSave {
  plan: Plan;
  source: string;
}

/**
 * Persist a whole preview run in chunked batches.
 *
 * The per-plan insert this replaces cost one round-trip per product: a
 * 20 000-product store meant 20 000 sequential INSERTs, which is most of the
 * minute a whole-store preview used to take before it ran out of heap.
 * Returns the new ids in the SAME ORDER as the input, because the caller pairs
 * them back up with the products it planned.
 */
export async function savePlans(
  toSave: PlanToSave[],
  market: string,
  runId: string,
): Promise<{ id: string; summary: PlanSummary }[]> {
  const out: { id: string; summary: PlanSummary }[] = [];
  for (let i = 0; i < toSave.length; i += INSERT_CHUNK) {
    const slice = toSave.slice(i, i + INSERT_CHUNK);
    const summaries = slice.map((s) => summarize(s.plan.items));
    const rows = await db
      .insert(plans)
      .values(
        slice.map((s, j) => ({
          runId,
          sku: s.plan.sku,
          currency: s.plan.currency,
          market,
          source: s.source,
          generatedAt: new Date(s.plan.generatedAt),
          items: s.plan.items,
          summary: summaries[j],
        })),
      )
      .returning({ id: plans.id });
    // Postgres returns RETURNING rows in insertion order for a multi-row
    // VALUES insert, which is what keeps this pairing honest.
    rows.forEach((r, j) => out.push({ id: r.id, summary: summaries[j] }));
  }
  return out;
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

/** Several plans in ONE query — the apply resolves a run in chunks, not row by row. */
export async function getPlansByIds(ids: string[]): Promise<Map<string, Plan>> {
  const out = new Map<string, Plan>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const rows = await db
      .select()
      .from(plans)
      .where(inArray(plans.id, ids.slice(i, i + READ_CHUNK)));
    for (const r of rows) {
      out.set(r.id, {
        sku: r.sku,
        currency: r.currency,
        generatedAt: r.generatedAt.toISOString(),
        items: r.items,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* A preview RUN: the whole set, answered in SQL                       */
/* ------------------------------------------------------------------ */

/** Every plan id of a run — ids only, so the apply never loads the items. */
export async function planRunIds(runId: string): Promise<string[]> {
  const rows = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.runId, runId))
    .orderBy(asc(plans.id));
  return rows.map((r) => r.id);
}

export interface PlanRunScope {
  /** Store products the run covers — the cleanup never touches anything else. */
  previewedProductIds: number[];
  /** Variations the source can price: kept, and made available when zero-stock. */
  kicksdbVariationIds: number[];
  /** Products owned by a feed (finite stock) — excluded from KicksDB cleanup. */
  feedProductIds: number[];
}

/**
 * The cleanup scope of a whole run, unrolled from the plan items IN SQL.
 *
 * These three arrays are what the Sync tab used to compute in the browser by
 * walking every plan it held — which is exactly why it had to hold every plan.
 * On a 20 000-product store `kicksdbVariationIds` alone is a few hundred
 * thousand integers; it now never leaves the database except as the answer.
 */
export async function planRunScope(runId: string): Promise<PlanRunScope> {
  const res = await db.execute(sql`
    with items as (
      select ${plans.source} as source, i as item
      from ${plans}, jsonb_array_elements(${plans.items}) as i
      where ${plans.runId} = ${runId}
    )
    select
      coalesce((
        select array_agg(distinct (item->>'storeProductId')::int)
        from items where item->>'storeProductId' is not null
      ), '{}') as previewed,
      coalesce((
        select array_agg(distinct (item->>'storeVariationId')::int)
        from items
        where item->>'storeVariationId' is not null and item->>'proposedPrice' is not null
      ), '{}') as priceable,
      coalesce((
        select array_agg(distinct (item->>'storeProductId')::int)
        from items where item->>'storeProductId' is not null and source <> 'kicksdb'
      ), '{}') as feed
  `);
  const row = rowsOf<Record<string, unknown>>(res)[0];
  const ints = (v: unknown): number[] =>
    Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
  return {
    previewedProductIds: ints(row?.previewed),
    kicksdbVariationIds: ints(row?.priceable),
    feedProductIds: ints(row?.feed),
  };
}
