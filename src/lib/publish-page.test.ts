import { describe, it, expect } from "vitest";
import { pagePublishTargets, PAGE_LIMIT, type PublishFilterable } from "./publish-page";

function row(over: Partial<PublishFilterable> & { sku: string }): PublishFilterable {
  return {
    title: `Title ${over.sku}`,
    brand: "Nike",
    source: "goldensneakers",
    onStore: false,
    ...over,
  };
}

/** A shop that has published nothing: the delta IS the catalog. */
const bigDelta = Array.from({ length: 4000 }, (_, i) => row({ sku: `SKU-${i}` }));

describe("pagePublishTargets — the delta is unbounded, the page is not", () => {
  it("ships one page however large the delta is, and says how many matched", () => {
    const page = pagePublishTargets(bigDelta);
    expect(page.candidates.length).toBe(PAGE_LIMIT);
    expect(page.matched).toBe(4000);
    expect(page.counts.missing).toBe(4000);
    expect(page.counts.total).toBe(4000);
  });

  it("hides products the store already has, unless asked", () => {
    const rows = [row({ sku: "A" }), row({ sku: "B", onStore: true })];
    expect(pagePublishTargets(rows).candidates.map((c) => c.sku)).toEqual(["A"]);
    expect(
      pagePublishTargets(rows, { showOnStore: true }).candidates.map((c) => c.sku),
    ).toEqual(["A", "B"]);
    // The delta count is the delta count whichever way the toggle is set.
    expect(pagePublishTargets(rows, { showOnStore: true }).counts.missing).toBe(1);
  });

  it("searches SKU, title and brand, case-insensitively", () => {
    const rows = [
      row({ sku: "DM0032-601" }),
      row({ sku: "IH6001", title: "Samba OG" }),
      row({ sku: "JI2626", brand: "Asics" }),
    ];
    expect(pagePublishTargets(rows, { q: "samba" }).candidates.map((c) => c.sku)).toEqual(["IH6001"]);
    expect(pagePublishTargets(rows, { q: "ASICS" }).candidates.map((c) => c.sku)).toEqual(["JI2626"]);
    expect(pagePublishTargets(rows, { q: "dm0032" }).candidates.map((c) => c.sku)).toEqual(["DM0032-601"]);
  });

  it("searches the WHOLE delta, not just the page the browser had", () => {
    // The row the old client-side filter could never have found: past the page.
    const rows = [...bigDelta, row({ sku: "NEEDLE", title: "Way past the page" })];
    const page = pagePublishTargets(rows, { q: "needle" });
    expect(page.candidates.map((c) => c.sku)).toEqual(["NEEDLE"]);
    expect(page.matched).toBe(1);
  });

  it("counts the source split over the pool, before the lens narrows it", () => {
    const rows = [
      row({ sku: "A", source: "goldensneakers" }),
      row({ sku: "B", source: "kicksdb" }),
      row({ sku: "C", source: "kicksdb" }),
    ];
    const page = pagePublishTargets(rows, { source: "goldensneakers" });
    expect(page.candidates.map((c) => c.sku)).toEqual(["A"]);
    // Tabs keep showing the full split, or they could never be clicked back.
    expect(page.counts).toMatchObject({ all: 3, goldensneakers: 1, kicksdb: 2 });
  });

  it("ignores a lens the shop has no second source for", () => {
    // Single-source shop: the tabs are hidden, so a stale "kicksdb" in the URL
    // must not empty the list with no control left to clear it.
    const rows = [row({ sku: "A" }), row({ sku: "B" })];
    expect(pagePublishTargets(rows, { source: "kicksdb" }).candidates.length).toBe(2);
  });

  it("treats every non-GS source as StockX, the way the tabs read", () => {
    const rows = [row({ sku: "A", source: "goldensneakers" }), row({ sku: "B", source: "woo" })];
    const page = pagePublishTargets(rows, { source: "kicksdb" });
    expect(page.candidates.map((c) => c.sku)).toEqual(["B"]);
  });
});
