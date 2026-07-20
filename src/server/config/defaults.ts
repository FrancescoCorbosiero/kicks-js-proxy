import type { AppConfig, ConnectionConfig, ScopedPricingRule } from "@core/config";

/**
 * GoldenSneakers pricing is decided UPSTREAM: VAT and markup are set as query
 * params on their API and `presented_price` arrives final. This source-scoped
 * rule makes the engine a passthrough for GS products — zero markup, bands
 * explicitly cleared (an empty array overrides the general rule's bands), no
 * rounding, no VAT. Manual locks and the sale rule still apply on top.
 */
export function goldenSneakersPassthroughRule(): ScopedPricingRule {
  return {
    id: "goldensneakers-passthrough",
    scope: { source: "goldensneakers" },
    enabled: true,
    sourceDeliveryType: "standard",
    markupPercent: 0,
    markupBands: [],
    rounding: { mode: "none" },
    tax: { priceIncludesVat: false, vatRatePercent: 0 },
  };
}

/**
 * A sensible starting AppConfig: one general pricing rule with a DYNAMIC,
 * price-banded markup on the raw KicksDB ask (≤150€ → 35%, ≤300€ → 30%,
 * ≤500€ → 25%, above → 19%). The band IS the total shelf uplift: VAT is
 * considered included in the resulting price, never added on top (an ask of
 * €100 prices at €135.99 with charm rounding, not €135 × 1.22). Charm .99
 * rounding, UPC-first matching, dry-run-by-default apply. Operators refine
 * this in the config UI — new pricing behaviour is just more rows, never code.
 */
export function buildDefaultConfig(connection: ConnectionConfig): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 900,
      query: {
        sort: "release_date",
        limit: 10,
        display: { traits: true, variants: true, identifiers: true, prices: true },
      },
    },
    pricingRules: [
      {
        id: "general",
        scope: {}, // matches everything
        enabled: true,
        sourceDeliveryType: "standard",
        // Banded by the raw ask (pre-markup, pre-VAT). markupPercent is the
        // fallback for anything the bands miss (mirrors the top band).
        markupPercent: 19,
        markupBands: [
          { upTo: 150, percent: 35 },
          { upTo: 300, percent: 30 },
          { upTo: 500, percent: 25 },
          { upTo: null, percent: 19 },
        ],
        minAsks: 1,
        rounding: { mode: "charm", increment: 0.99 },
        // The band is the TOTAL uplift over the ask — VAT is inside the shelf
        // price, not stacked on top of the markup.
        tax: { priceIncludesVat: false, vatRatePercent: 0 },
        // No maxDeltaPercent by default: the KicksDB price always wins, regardless
        // of how far it is from the current store price. Add one per rule if you
        // want a guardrail against big jumps.
      },
      goldenSneakersPassthroughRule(),
    ],
    matching: {
      strategyOrder: ["upc", "skuPattern", "manual"],
      skuTemplate: "{sku}-{sizeType}-{size}",
    },
    apply: {
      includeActions: ["update"],
      dryRunByDefault: true,
      requireApprovalAboveDeltaPercent: 25,
      concurrency: 3,
      wooBatchSize: 100,
      retry: { attempts: 4, backoffMs: 500 },
      schedule: null,
    },
    connection,
  };
}
