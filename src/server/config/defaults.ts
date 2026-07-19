import type { AppConfig, ConnectionConfig } from "@core/config";

/**
 * A sensible starting AppConfig: one general pricing rule (17% markup, VAT 22%,
 * charm .99 rounding), UPC-first matching, dry-run-by-default apply. Operators
 * refine this in the config UI — new pricing behaviour is just more rows, never code.
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
