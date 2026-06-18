/**
 * sample.ts — realistic demo data that flows through the REAL core.
 *
 * These are shaped exactly like KicksDB product responses, mapped via the
 * production `mapKicksProduct()`. The dashboard runs the genuine pricing engine
 * over this data, so the plan/diff you see is computed, not mocked.
 *
 * Replace this module with live SourcePort calls when wiring real adapters.
 */

import type { AppConfig } from "@/config";

/* Raw KicksDB-shaped products (the subset the mapper consumes). */
export const RAW_PRODUCTS = [
  {
    id: "stockx-aj1-chicago",
    sku: "DZ5485-612",
    title: "Air Jordan 1 Retro High OG Chicago Lost & Found",
    brand: "Jordan",
    image: "AJ1",
    variants: row(["7", "8", "8.5", "9", "9.5", "10", "10.5", "11", "12"], 168, [
      14, 22, 31, 40, 55, 48, 33, 19, 9,
    ]),
  },
  {
    id: "stockx-dunk-panda",
    sku: "DD1391-100",
    title: "Nike Dunk Low Retro White Black Panda",
    brand: "Nike",
    image: "DNK",
    variants: row(["6", "7", "8", "9", "10", "11", "12", "13"], 96, [
      62, 88, 120, 140, 110, 71, 40, 12,
    ]),
  },
  {
    id: "stockx-yeezy-slide",
    sku: "HQ6448",
    title: "adidas Yeezy Slide Onyx",
    brand: "adidas",
    image: "YZY",
    variants: row(["7", "8", "9", "10", "11", "12"], 71, [33, 48, 60, 52, 28, 11]),
  },
  {
    id: "stockx-nb-2002r",
    sku: "M2002RDD",
    title: "New Balance 2002R Protection Pack Rain Cloud",
    brand: "New Balance",
    image: "NB",
    variants: row(["7.5", "8", "9", "9.5", "10.5", "11"], 142, [8, 15, 24, 19, 13, 6]),
  },
  {
    id: "stockx-sb-jarritos",
    sku: "FD0860-001",
    title: "Nike SB Dunk Low Jarritos",
    brand: "Nike",
    image: "SB",
    // intentionally thin liquidity on some sizes -> exercises minAsks skips
    variants: row(["8", "9", "10", "11", "12"], 240, [3, 7, 12, 4, 2]),
  },
  {
    id: "stockx-samba-og",
    sku: "B75806",
    title: "adidas Samba OG White Black Gum",
    brand: "adidas",
    image: "SMB",
    variants: row(["6.5", "7", "8", "9", "10", "11", "12"], 88, [40, 66, 95, 102, 77, 41, 18]),
  },
];

/** Build KicksDB-shaped variants from parallel arrays. */
function row(sizes: string[], baseAsk: number, asks: number[]) {
  return sizes.map((size, i) => {
    // gentle price curve: mid sizes a touch higher
    const mid = (sizes.length - 1) / 2;
    const lift = 1 + (1 - Math.abs(i - mid) / sizes.length) * 0.18;
    const price = Math.round(baseAsk * lift);
    return {
      id: `${size}-v`,
      size,
      size_type: "us m",
      currency: "EUR",
      market: "IT",
      identifiers: [{ identifier: `0019${1000 + i}${sizes.length}`, identifier_type: "UPC" }],
      prices: [
        { price, asks: asks[i] ?? 1, type: "standard" as const },
        { price: price + 22, asks: Math.max(1, Math.round((asks[i] ?? 1) * 0.4)), type: "express_expedited" as const },
      ],
    };
  });
}

/* A sensible starting config — general rule + brand/model overrides. */
export const SAMPLE_CONFIG: AppConfig = {
  source: {
    market: "IT",
    defaultDeliveryType: "standard",
    batchChunkSize: 50,
    cacheTtlSeconds: 1800,
    query: {
      sort: "release_date",
      limit: 50,
      display: { traits: true, variants: true, identifiers: true, prices: true },
    },
  },
  pricingRules: [
    {
      id: "base",
      enabled: true,
      scope: {},
      markupPercent: 12,
      minAsks: 5,
      rounding: { mode: "charm", increment: 0.99 },
      tax: { priceIncludesVat: true, vatRatePercent: 22 },
      maxDeltaPercent: 35,
    },
    {
      id: "jordan-premium",
      enabled: true,
      scope: { brand: "Jordan" },
      markupPercent: 18,
      floor: 180,
    },
    {
      id: "nike-dunk",
      enabled: true,
      scope: { brand: "Nike", model: "Dunk" },
      markupPercent: 15,
    },
    {
      id: "adidas-value",
      enabled: true,
      scope: { brand: "adidas" },
      markupPercent: 9,
      rounding: { mode: "nearest", increment: 5 },
    },
    {
      id: "small-size-bump",
      enabled: false,
      scope: { sizeMax: 7 },
      markupPercent: 22,
    },
  ],
  matching: {
    strategyOrder: ["upc", "skuPattern", "manual"],
    skuTemplate: "{sku}-{sizeType}-{size}",
  },
  apply: {
    includeActions: ["update", "create"],
    dryRunByDefault: true,
    requireApprovalAboveDeltaPercent: 20,
    concurrency: 4,
    wooBatchSize: 80,
    retry: { attempts: 3, backoffMs: 500 },
    schedule: { cron: "0 */6 * * *" },
  },
  connection: {
    kicksDbApiKey: "kx_live_••••••••••••8f21",
    woo: {
      baseUrl: "https://shop.kicks.example",
      consumerKey: "ck_••••••••••••",
      consumerSecret: "cs_••••••••••••",
    },
    marketToCurrency: { IT: "EUR", US: "USD", UK: "GBP" },
  },
};

/* Simulated current store prices, keyed by stockxVariantId, for diffing. */
export const STORE_PRICES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (const p of RAW_PRODUCTS) {
    for (const v of p.variants) {
      // store sits a little stale vs. the live ask
      const base = v.prices[0].price;
      map[v.id] = Math.round(base * (1 + 0.1) + 0.99 * 0) - 0.01;
    }
  }
  return map;
})();

/* Recent run history for the dashboard timeline. */
export const RUN_HISTORY = [
  { id: "r-1041", at: iso(-0.4), trigger: "scheduled", scanned: 312, updated: 188, created: 4, skipped: 41, held: 12, failed: 0, status: "ok" },
  { id: "r-1040", at: iso(-6.2), trigger: "scheduled", scanned: 312, updated: 156, created: 0, skipped: 38, held: 9, failed: 2, status: "warn" },
  { id: "r-1039", at: iso(-12.1), trigger: "manual", scanned: 48, updated: 31, created: 11, skipped: 6, held: 0, failed: 0, status: "ok" },
  { id: "r-1038", at: iso(-18.5), trigger: "scheduled", scanned: 312, updated: 201, created: 1, skipped: 44, held: 15, failed: 0, status: "ok" },
  { id: "r-1037", at: iso(-24.0), trigger: "scheduled", scanned: 309, updated: 174, created: 0, skipped: 39, held: 7, failed: 0, status: "ok" },
] as const;

function iso(hoursAgo: number): string {
  return new Date(Date.now() + hoursAgo * 3600_000).toISOString();
}
