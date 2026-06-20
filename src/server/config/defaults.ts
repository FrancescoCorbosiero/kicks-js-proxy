import type { AppConfig, ConnectionConfig, MarkupTier } from "@core/config";

/**
 * Recommended dynamic-markup schedule (opt-in). Bands are matched on the StockX
 * ask (our cost, in market currency): cheaper pairs earn a higher markup % while
 * expensive ones stay competitive. Used to pre-fill the editor when an operator
 * turns dynamic markup on; flat 17% remains the out-of-the-box default.
 */
export const DEFAULT_MARKUP_TIERS: MarkupTier[] = [
  { upTo: 100, markupPercent: 35 },
  { upTo: 200, markupPercent: 25 },
  { upTo: 350, markupPercent: 18 },
  { upTo: 600, markupPercent: 12 },
  { upTo: null, markupPercent: 8 },
];

/**
 * A sensible starting AppConfig: one general pricing rule (12% markup, VAT 22%,
 * charm .99 rounding), UPC-first matching, dry-run apply. Operators refine this
 * in the config UI — new pricing behaviour is just more rows, never code.
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
        markupPercent: 17,
        minAsks: 1,
        rounding: { mode: "charm", increment: 0.99 },
        tax: { priceIncludesVat: true, vatRatePercent: 22 },
        // No maxDeltaPercent by default: the KicksDB price always wins, regardless
        // of how far it is from the current store price. Add one per rule if you
        // want a guardrail against big jumps.
      },
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
