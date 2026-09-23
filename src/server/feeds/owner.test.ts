import { describe, it, expect, vi } from "vitest";
import type { FeedItemRow } from "@/server/db/schema";

const rows = new Map<string, FeedItemRow[]>();
vi.mock("./repo", () => ({
  GS_FEED: "goldensneakers",
  knownOffersBySku: vi.fn(async () => rows),
}));

const { gsFeedStatus } = await import("./owner");

function row(sku: string, euNorm: string, active: boolean, quantity = 2): FeedItemRow {
  return {
    feed: "goldensneakers",
    sku,
    euNorm,
    sizeLabel: euNorm,
    sizeUs: "",
    barcode: "",
    offerPrice: 80,
    presentedPrice: 120,
    quantity,
    productName: "P",
    brandName: "B",
    image: "",
    active,
    raw: null,
    firstSeenAt: new Date(),
    syncedAt: new Date(),
  };
}

describe("gsFeedStatus", () => {
  it("keeps owned, delisted and not-ours apart", async () => {
    rows.clear();
    rows.set("A-1", [row("A-1", "42", true), row("A-1", "43", false)]); // partial
    rows.set("B-2", [row("B-2", "42", false), row("B-2", "43", false)]); // fully delisted
    const s = await gsFeedStatus(["A-1", "B-2", "C-3"], "IT", null);
    expect([...s.owned.keys()]).toEqual(["A-1"]);
    expect([...s.delisted]).toEqual(["B-2"]);
    // The partial case is unchanged: the dead size stays, at qty 0.
    expect(s.owned.get("A-1")!.stockBySize).toEqual({ "42": 2, "43": 0 });
  });

  it("a KicksDB pin takes the product out of the feed's hands entirely", async () => {
    rows.clear();
    rows.set("B-2", [row("B-2", "42", false)]);
    const overrides = { products: { "B-2": { owner: "kicksdb" } } } as never;
    const s = await gsFeedStatus(["B-2"], "IT", overrides);
    expect(s.delisted.size).toBe(0);
    expect(s.owned.size).toBe(0);
  });
});
