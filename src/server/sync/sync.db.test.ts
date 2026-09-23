import { describe, it, expect } from "vitest";

/**
 * Real-SQL tests of the stepped store sync (and the delisting it plans).
 * Opt-in: they need a THROWAWAY Postgres with the migrations applied, and they
 * delete feed rows. Run with
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://…@localhost:…/… REDIS_URL=… npm test
 *
 * Imports are dynamic because the db client validates the environment on load.
 */
const url = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_DB_TESTS === "1" && /@(localhost|127\.0\.0\.1)[:/]/.test(url);

const load = async () => ({
  ...(await import("drizzle-orm")),
  ...(await import("@/server/db/client")),
  ...(await import("@/server/db/schema")),
  ...(await import("@/server/plans/repo")),
  ...(await import("@/server/store-json/repo")),
  ...(await import("./runs")),
  ...(await import("@/server/actions/preview")),
  ...(await import("@/server/actions/sync")),
});

const plan = (sku: string) => ({ plan: { sku, currency: "EUR", generatedAt: new Date().toISOString(), items: [] }, source: "kicksdb" });

const vrt = (id: number, sku: string, eu: string, qty: number | null) => ({
  id, sku: `${sku}-${eu}`, regular_price: "120.00", attributes: { attribute_pa_taglia: eu },
  manage_stock: qty != null, stock_quantity: qty,
});
const feedRow = (sku: string, eu: string, active: boolean, quantity: number) => ({
  feed: "goldensneakers", sku, euNorm: eu, sizeLabel: eu, quantity, active,
  presentedPrice: 120, offerPrice: 80, productName: sku, brandName: "B",
});

describe.skipIf(!enabled)("sync runs (real SQL)", () => {
  it("walks, drops an uncommitted step, guards the cursor, finishes", async () => {
    const { eq, db, plans, savePlans, cancelSyncRun, commitSyncStep, createSyncRun, dropUncommittedPlans, failSyncRun, getSyncRun, syncRunApplicable } = await load();
    const run = await createSyncRun("IT", ["A", "B", "C"]);
    expect(run.status).toBe("running");
    expect(await syncRunApplicable(run.id)).toBe(false);

    await savePlans([plan("A")], "IT", run.id);
    const r1 = await commitSyncStep(run, { cursor: 1, planned: 1, totals: { update: 1, create: 0, noop: 0, skip: 0 }, notFound: [], notFoundTotal: 0, delisted: 0, warning: null, catalog: null });
    expect(r1.cursor).toBe(1);
    expect(r1.status).toBe("running");

    // a step that saved and then died
    await savePlans([plan("B")], "IT", run.id);
    await dropUncommittedPlans(r1);
    const left = await db.select().from(plans).where(eq(plans.runId, run.id));
    expect(left.map((p) => p.sku)).toEqual(["A"]);

    // stale commit (started from cursor 0) is refused
    const stale = await commitSyncStep(run, { cursor: 2, planned: 9, totals: r1.totals, notFound: [], notFoundTotal: 0, delisted: 0, warning: null, catalog: null });
    expect(stale.cursor).toBe(1);
    expect(stale.planned).toBe(1);

    const r2 = await commitSyncStep(r1, { cursor: 3, planned: 3, totals: r1.totals, notFound: ["C"], notFoundTotal: 1, delisted: 2, warning: "w", catalog: { total: 5, added: 1, rejected: 0 } });
    expect(r2.status).toBe("done");
    expect(r2.finishedAt).not.toBeNull();
    expect(r2.notFound).toEqual(["C"]);
    expect(await syncRunApplicable(run.id)).toBe(true);
    // a finished run cannot be failed or cancelled after the fact
    await cancelSyncRun(run.id);
    expect((await getSyncRun(run.id))!.status).toBe("done");
  });

  it("a failed run is never applicable; a manual preview run always is", async () => {
    const { eq, db, plans, savePlans, cancelSyncRun, commitSyncStep, createSyncRun, dropUncommittedPlans, failSyncRun, getSyncRun, syncRunApplicable } = await load();
    const run = await createSyncRun("IT", ["A"]);
    const f = await failSyncRun(run.id, "boom");
    expect(f.status).toBe("failed");
    expect(await syncRunApplicable(run.id)).toBe(false);
    expect(await syncRunApplicable("00000000-0000-4000-8000-000000000000")).toBe(true);
  });
});

describe.skipIf(!enabled)("stepped store sync, solo-GS (no KicksDB), real SQL", () => {
  it("zeroes a delisted product, leaves manual ones alone, reports it", async () => {
    const { eq, db, feedItems, plans, saveSnapshot, advanceStoreSync, startStoreSync, applySyncPrices } = await load();
    await db.delete(feedItems);
    await saveSnapshot({
      products: [
        { id: 1, sku: "M990JJ3", name: "NB", variations: [vrt(11, "M990JJ3", "42", 3), vrt(12, "M990JJ3", "43", null)] },
        { id: 2, sku: "OWNED-1", name: "Owned", variations: [vrt(21, "OWNED-1", "42", 1)] },
        { id: 3, sku: "MANUAL-1", name: "Manual", variations: [vrt(31, "MANUAL-1", "42", 5)] },
      ],
    } as never);
    await db.insert(feedItems).values([
      feedRow("M990JJ3", "42", false, 3),
      feedRow("M990JJ3", "43", false, 2),
      feedRow("OWNED-1", "42", true, 4),
    ]);

    const started = await startStoreSync("IT");
    expect(started.ok).toBe(true);
    let progress = started.progress!;
    const seen: string[] = [];
    while (!progress.done) {
      const res = await advanceStoreSync(progress.runId);
      expect(res.ok).toBe(true);
      progress = res.progress!;
      seen.push(...progress.plans.map((p) => p.sku));
      expect(progress.status).not.toBe("failed");
    }
    const stats = progress.result!.stats!;
    expect(stats.delisted).toBe(1);
    expect(stats.notFound).toEqual(["MANUAL-1"]); // never in the feed, no KicksDB: untouched
    expect(seen.sort()).toEqual(["M990JJ3", "OWNED-1"]);

    const rows = await db.select().from(plans).where(eq(plans.runId, progress.runId));
    const delisted = rows.find((r) => r.sku === "M990JJ3")!;
    expect(delisted.source).toBe("goldensneakers");
    expect(delisted.items.map((i) => [i.storeVariationId, i.action, i.stockQuantity, i.proposedPrice])).toEqual([
      [11, "update", 0, null],
      [12, "update", 0, null], // unmanaged → managed at 0
    ]);
    const owned = rows.find((r) => r.sku === "OWNED-1")!;
    expect(owned.items[0].stockQuantity).toBe(4);

    const dry = await applySyncPrices({ runId: progress.runId, priceScope: "all", selections: [], excluded: [], dryRun: true, sanitize: true, backfillGtins: true });
    expect(dry.ok).toBe(true);
    const writes = dry.outcome!.changes.filter((c) => c.sku === "M990JJ3").map((c) => [c.storeVariationId, c.newStock]);
    expect(writes.sort()).toEqual([[11, 0], [12, 0]]);
  });

  it("an unfinished run is refused by the apply", async () => {
    const { eq, db, feedItems, plans, saveSnapshot, advanceStoreSync, startStoreSync, applySyncPrices } = await load();
    const started = await startStoreSync("IT");
    const res = await applySyncPrices({ runId: started.progress!.runId, priceScope: "all", selections: [], excluded: [], dryRun: true, sanitize: false, backfillGtins: false });
    expect(res.ok).toBe(false);
  });
});
