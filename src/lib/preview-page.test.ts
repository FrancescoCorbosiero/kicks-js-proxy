import { describe, expect, it } from "vitest";
import type { Plan, PlanAction } from "@core/core-spine";
import { PREVIEW_PAGE_LIMIT, PreviewPage, pagePreviewPlans, previewWeight } from "./preview-page";
import { emptySummary, type PlanSummary, type PreviewPlan } from "./plan";

function summary(of: Partial<PlanSummary>): PlanSummary {
  return { ...emptySummary(), ...of };
}

function row(sku: string, s: Partial<PlanSummary>) {
  return { sku, summary: summary(s) };
}

/** A PreviewPlan with just enough shape for the pager. */
function plan(sku: string, actions: PlanAction[]): PreviewPlan {
  const items = actions.map((action, i) => ({
    stockxVariantId: `${sku}-v${i}`,
    sizeLabel: String(40 + i),
    action,
    proposedPrice: 100,
    currentPrice: 90,
    storeProductId: 1,
    storeVariationId: 10 + i,
  })) as unknown as Plan["items"];
  const s = emptySummary();
  for (const a of actions) s[a] += 1;
  return {
    planId: `plan-${sku}`,
    market: "IT",
    sku,
    title: sku,
    brand: "Nike",
    source: "goldensneakers",
    plan: { sku, currency: "EUR", generatedAt: "2026-01-01T00:00:00.000Z", items },
    summary: s,
    euSizes: {},
    exactMatch: false,
    followSaleRule: true,
    manualPrices: {},
  };
}

describe("previewWeight", () => {
  it("counts only what can be acted on", () => {
    expect(previewWeight(row("A", { update: 3, create: 2, noop: 99, skip: 50 }))).toBe(5);
    expect(previewWeight(row("B", { noop: 1000 }))).toBe(0);
  });
});

describe("PreviewPage", () => {
  it("keeps everything when the run fits", () => {
    const page = new PreviewPage<ReturnType<typeof row>>(10);
    page.add([row("A", { update: 1 }), row("B", { update: 2 })]);
    expect(page.take().map((r) => r.sku)).toEqual(["B", "A"]);
  });

  it("never exceeds the limit, however many chunks arrive", () => {
    const page = new PreviewPage<ReturnType<typeof row>>(5);
    for (let chunk = 0; chunk < 40; chunk++) {
      page.add(
        Array.from({ length: 50 }, (_, i) => row(`SKU-${chunk}-${i}`, { noop: 1 })),
      );
    }
    expect(page.take()).toHaveLength(5);
  });

  it("cuts the idle tail, not the work", () => {
    const page = new PreviewPage<ReturnType<typeof row>>(3);
    // 500 products with nothing to do arrive BEFORE the three that matter.
    page.add(Array.from({ length: 500 }, (_, i) => row(`IDLE-${i}`, { noop: 24 })));
    page.add([
      row("BUSY-1", { update: 20 }),
      row("BUSY-2", { update: 12, create: 3 }),
      row("BUSY-3", { create: 8 }),
    ]);
    expect(page.take().map((r) => r.sku)).toEqual(["BUSY-1", "BUSY-2", "BUSY-3"]);
  });

  it("orders by work, then by SKU, so a run is reproducible", () => {
    const page = new PreviewPage<ReturnType<typeof row>>(4);
    page.add([
      row("ZZ", { update: 2 }),
      row("AA", { update: 2 }),
      row("MM", { update: 5 }),
      row("BB", { noop: 3 }),
    ]);
    expect(page.take().map((r) => r.sku)).toEqual(["MM", "AA", "ZZ", "BB"]);
  });

  it("survives an empty run", () => {
    const page = new PreviewPage<ReturnType<typeof row>>(10);
    page.add([]);
    expect(page.take()).toEqual([]);
  });
});

describe("pagePreviewPlans", () => {
  it("bounds a whole-store run and keeps the actionable products", () => {
    const plans = [
      ...Array.from({ length: 1000 }, (_, i) => plan(`IDLE-${i}`, ["noop", "noop"])),
      plan("WORK-A", ["update", "update", "update"]),
      plan("WORK-B", ["update"]),
    ];
    const page = pagePreviewPlans(plans, 2);
    expect(page.map((p) => p.sku)).toEqual(["WORK-A", "WORK-B"]);
    // The page carries whole plans — the browser renders these rows.
    expect(page[0].plan.items).toHaveLength(3);
  });

  it("defaults to the shipped limit", () => {
    const plans = Array.from({ length: PREVIEW_PAGE_LIMIT + 250 }, (_, i) =>
      plan(`SKU-${i}`, ["update"]),
    );
    expect(pagePreviewPlans(plans)).toHaveLength(PREVIEW_PAGE_LIMIT);
  });
});
