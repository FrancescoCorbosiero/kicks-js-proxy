# kicks-js-proxy

Internal tool for a single sneaker shop: reads StockX pricing/product data from the
KicksDB API, lets an operator preview repricing changes, and produces a JSON file to
re-import into one WooCommerce store.

Next.js (App Router) · TypeScript · Tailwind + shadcn-style primitives · Drizzle/Postgres
· Redis (optional KicksDB cache) · Zod. **No `@tanstack/*`** (enforced in CI).

The store integration is **JSON round-trip**, not live REST: the operator exports a
WooCommerce model (`format: rp_cm_roundtrip`), uploads it here, previews repricing, and
downloads a patched model to re-import. Only `regular_price` is changed; SEO/GMC
attributes, descriptions, images and stock are preserved. The operator owns the actual
Woo import/export.

## Setup

```bash
npm ci
cp .env.example .env            # KicksDB key, DB/Redis URLs (Woo creds no longer needed)
docker compose up -d            # local Postgres + Redis (dev only)
npm run db:migrate              # apply migrations (creates all tables)
npm run dev                     # http://localhost:3000/preview
```

All secrets live in env (typed + Zod-validated in `src/lib/env.ts`); none are persisted.

## Flow

1. **Upload store snapshot** — paste/upload the WooCommerce round-trip JSON. It's
   validated and stored (single active snapshot).
2. **Preview** (`/preview`): fetch StockX by SKU (persistent catalog cache) or query →
   match each variant to a store variation **by EU size** → `buildPlan` → grouped,
   collapsible diff (update / create / noop / skip) with per-row + quick-select.
3. **Export** — download the re-import JSON: `regular_price` patched on the selected,
   matched variations; only changed products included; everything else preserved.

## Caching

Two independent layers, both best-effort (an outage degrades to a live fetch,
never a hard failure):

- **Redis TTL cache** (`src/server/cache/`) — short-lived price/query results,
  keyed by market; controlled by `source.cacheTtlSeconds`.
- **Persistent catalog** (`catalog_products`, `src/server/catalog/`) — the
  **ever-increasing, independent** layer. It is unique by `(market, sku)` and
  entries are permanent: the SKU set only grows, never shrinks. Every preview
  (manual SKU mode *and* the file-upload flow) feeds it. A SKU is added **only
  after a `GET /stockx/products` lookup returns a matching product (HTTP 200)**,
  so every catalog SKU is guaranteed fetchable on KicksDB. Verification is paid
  once per brand-new SKU — re-uploading known SKUs is free. Stale entries are
  refetched for fresh prices (TTL), but the SKU never leaves the catalog. The
  preview header shows the live catalog size and how many SKUs the run added.

  The **KicksDB catalog** panel on `/preview` discovers this set on demand: load a
  market's whole known-fetchable SKU list (`listCatalog` → `listCatalogEntries`),
  filter by SKU/model/brand, and copy the SKUs out. You can also **drive a preview
  straight from the catalog** — select SKUs (or all filtered) and reprice just those:
  it calls `previewFromStore(market, skus)`, which fetches those SKUs via the bulk
  path and matches them against the snapshot, so the export stays a valid Woo
  re-import. This is why the store snapshot is still required: the catalog has StockX
  SKUs/prices/sizes but none of Woo's variation ids, SEO, GMC or stock — only the
  snapshot does. The store bar softly warns when that snapshot is over a week old
  (re-export from Woo and reload to refresh it).

Large uploads/exports: Server Actions cap the request body (1 MB by default);
`next.config.ts` raises `serverActions.bodySizeLimit` so multi-MB store JSON
round-trips through upload and re-import.

## Core

- `core/core-spine.ts`, `core/config.ts` — domain model, pricing engine
  (`computePrice`/`resolveEffectiveRule`), plan/diff (`buildPlan`), the `SourcePort` seam.
- `src/server/store-json/` — the Woo model schema, EU-size matching, and the price patch.

## Pricing config

Defaults in `src/server/config/defaults.ts` (general rule: 17% markup, 22% VAT, charm
`.99`, no delta cap). Edit markup / VAT / rounding / minAsks live from the **Pricing**
bar on `/preview` (saved to Postgres), or **Reset** it back to the defaults — no SQL.

## Operator overrides & sanitize

Overrides live in `store_overrides` (a single jsonb blob, `src/server/overrides/`),
keyed by stable SKU/size identities so a choice survives re-fetches and re-uploads.
They are applied in `buildPlan` with a fixed precedence — **manual price > sale rule >
computed price**:

- **Manual price lock** (variant level) — set a price directly on a matched variation
  from the preview table. It wins over the StockX-computed price and never drifts on
  re-runs (like the sale-price safe-lock), and is what the export writes.
- **Sale rule** — "leave a discounted variation untouched" is controlled by a bulk
  **Reprice discounted** switch in the Pricing bar (store-wide, default off = preserve),
  with a per-product override on each product header. Effective value =
  **product override → global default → preserve**.

**Sanitize is folded into the export**, not a separate file. `buildReimport`
(`src/server/store-json/patch.ts`) sanitizes then reprices in one pass: with the
export bar's **Sanitize file** toggle on (default), the single downloaded JSON cleans
the store and applies the selected price changes together.

KicksDB carries **no stock**, so a Woo `stock_quantity === 0` does **not** mean
unavailable. Sanitize therefore treats a zero-stock variation as a ghost **only when
it is not on KicksDB** — a zero-stock variation that StockX prices is *kept and made
available* (`stock_status: instock`, `manage_stock: false`, so it sells on demand),
never cut. The KicksDB-present set (`kicksdbVariationIds`) and the set of previewed
products (`previewedProductIds`, so a subset/manual run never touches products it never
fetched) are derived from the plans and passed into `buildReimport`. Sanitize also
realigns `pa_taglia` — per-variation value and parent option list — to the real sizes.
A product is emitted if it was repriced **or** cleaned; everything else is preserved.

## Scripts

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest (pricing/plan/match/patch core)
npm run guard:tanstack
npm run db:generate   # drizzle migration from schema
npm run build
```
