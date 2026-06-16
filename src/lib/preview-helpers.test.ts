import { describe, it, expect } from "vitest";
import { parseSkus } from "./skus";
import { summarize, emptySummary } from "./plan";
import type { PlanItem } from "@core/core-spine";

describe("parseSkus", () => {
  it("splits on commas, spaces, and newlines and de-duplicates", () => {
    expect(parseSkus("CT8012-047, DZ5485-612\nCT8012-047  AAA")).toEqual([
      "CT8012-047",
      "DZ5485-612",
      "AAA",
    ]);
  });

  it("returns empty array for blank input", () => {
    expect(parseSkus("   \n  ")).toEqual([]);
  });
});

describe("summarize", () => {
  const item = (action: PlanItem["action"]): PlanItem => ({
    stockxVariantId: "x",
    sizeLabel: "9",
    storeProductId: null,
    storeVariationId: null,
    currentPrice: null,
    proposedPrice: null,
    action,
  });

  it("counts per action", () => {
    const s = summarize([item("update"), item("update"), item("create"), item("skip")]);
    expect(s).toEqual({ update: 2, create: 1, noop: 0, skip: 1 });
  });

  it("emptySummary is all zeros", () => {
    expect(emptySummary()).toEqual({ update: 0, create: 0, noop: 0, skip: 0 });
  });
});
