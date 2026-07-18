import "server-only";
import { desc } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getPlanById } from "@/server/plans/repo";
import { getActiveConfig } from "@/server/config/repo";
import { chunk } from "@/server/adapters/http";
import { getWooClient } from "./client";

/**
 * The REST apply: execute selected plan rows as live price writes, grouped by
 * parent product (Woo's variations/batch is per-parent). Dry-run is the
 * default posture — it computes and records exactly what would be written
 * without touching the store. Every run (dry or live) lands in apply_audit.
 */

export interface ApplySelection {
  planId: string;
  variantIds: string[];
}

export interface ApplyChange {
  sku: string; // parent StockX style code (from the plan)
  sizeLabel: string;
  stockxVariantId: string;
  storeProductId: number;
  storeVariationId: number;
  currentPrice: number | null;
  newPrice: number;
}

export interface ApplyOutcome {
  auditId: string;
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: number;
  variations: number;
  updated: number;
  failed: { stockxVariantId: string; error: string }[];
  changes: ApplyChange[]; // what was (or would be) written
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/** Resolve the selections into concrete price writes (update rows only). */
async function collectChanges(selections: ApplySelection[]): Promise<ApplyChange[]> {
  const changes: ApplyChange[] = [];
  for (const sel of selections) {
    const plan = await getPlanById(sel.planId);
    if (!plan) continue;
    const wanted = new Set(sel.variantIds);
    for (const item of plan.items) {
      if (!wanted.has(item.stockxVariantId)) continue;
      if (item.action !== "update") continue; // "create" needs upsertProduct — out of scope
      if (item.storeProductId == null || item.storeVariationId == null) continue;
      if (item.proposedPrice == null) continue;
      changes.push({
        sku: plan.sku,
        sizeLabel: item.sizeLabel,
        stockxVariantId: item.stockxVariantId,
        storeProductId: item.storeProductId,
        storeVariationId: item.storeVariationId,
        currentPrice: item.currentPrice,
        newPrice: item.proposedPrice,
      });
    }
  }
  return changes;
}

export async function applyPrices(
  selections: ApplySelection[],
  dryRun: boolean,
): Promise<ApplyOutcome> {
  const changes = await collectChanges(selections);
  const byProduct = new Map<number, ApplyChange[]>();
  for (const c of changes) {
    const list = byProduct.get(c.storeProductId) ?? [];
    list.push(c);
    byProduct.set(c.storeProductId, list);
  }

  const [audit] = await db
    .insert(applyAudit)
    .values({
      status: dryRun ? "dry_run" : "running",
      dryRun,
      result: { products: byProduct.size, variations: changes.length },
    })
    .returning({ id: applyAudit.id });

  if (dryRun) {
    await db
      .update(applyAudit)
      .set({ finishedAt: new Date() })
      .where(eq(applyAudit.id, audit.id));
    return {
      auditId: audit.id,
      dryRun: true,
      status: "dry_run",
      products: byProduct.size,
      variations: changes.length,
      updated: 0,
      failed: [],
      changes,
    };
  }

  const config = await getActiveConfig();
  const client = getWooClient();
  const concurrency = Math.max(1, config.apply.concurrency ?? 3);
  const batchSize = Math.max(1, Math.min(config.apply.wooBatchSize ?? 100, 100));

  let updated = 0;
  const failed: { stockxVariantId: string; error: string }[] = [];

  await forEachLimit([...byProduct.entries()], concurrency, async ([productId, items]) => {
    for (const part of chunk(items, batchSize)) {
      try {
        await client.batchUpdateVariations(
          productId,
          part.map((c) => ({ id: c.storeVariationId, regular_price: c.newPrice.toFixed(2) })),
        );
        updated += part.length;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const c of part) failed.push({ stockxVariantId: c.stockxVariantId, error: message });
      }
    }
  });

  const status: ApplyAuditRow["status"] =
    failed.length === 0 ? "applied" : updated > 0 ? "partial" : "failed";
  await db
    .update(applyAudit)
    .set({ status, updatedCount: updated, failed, finishedAt: new Date() })
    .where(eq(applyAudit.id, audit.id));

  return {
    auditId: audit.id,
    dryRun: false,
    status,
    products: byProduct.size,
    variations: changes.length,
    updated,
    failed,
    changes,
  };
}

export interface ApplyHistoryEntry {
  id: string;
  status: ApplyAuditRow["status"];
  dryRun: boolean;
  updatedCount: number;
  failedCount: number;
  requestedVariations: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Recent apply runs (dry + live), newest first — the sync history panel. */
export async function listApplyHistory(limit = 10): Promise<ApplyHistoryEntry[]> {
  const rows = await db
    .select()
    .from(applyAudit)
    .orderBy(desc(applyAudit.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    dryRun: r.dryRun,
    updatedCount: r.updatedCount,
    failedCount: Array.isArray(r.failed) ? r.failed.length : 0,
    requestedVariations:
      typeof (r.result as { variations?: unknown } | null)?.variations === "number"
        ? ((r.result as { variations: number }).variations)
        : null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}
