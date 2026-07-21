# kicks-js-proxy

Internal tool for a single sneaker shop, built around one core domain: an
**ever-increasing catalog** of StockX products (via the KicksDB API). The
operator explores the catalog, locks manual prices, and syncs the WooCommerce
store **live over REST** — pull store state, preview a per-variant repricing
plan, apply the selected changes (dry-run first).

Next.js (App Router) · TypeScript · Tailwind + shadcn-style primitives · Drizzle/Postgres
· Redis (optional KicksDB cache) · Zod. **No `@tanstack/*`** (enforced in CI).

## Setup

```bash
npm ci
cp .env.example .env            # KicksDB key, Woo REST creds, DB/Redis URLs
docker compose up -d            # local Postgres + Redis (dev only)
npm run db:migrate              # apply migrations (creates all tables)
npm run dev                     # http://localhost:3000/catalog
```

All secrets live in env (typed + Zod-validated in `src/lib/env.ts`); none are persisted.

## The catalog (core domain)

`catalog_products` (`src/server/catalog/`) is unique by `(market, sku)`,
**append-only**, and **multi-source with provenance** (`source` column):

- `kicksdb` (default): added only after a `GET /stockx/products` lookup
  returns a matching product (HTTP 200) — guaranteed fetchable, re-priced by
  TTL via the refresh feed.
- `goldensneakers`: registered automatically by every feed sync for SKUs
  KicksDB doesn't carry, so supplier-only products are first-class in
  discovery (card with a GS badge, drawer, filters). Refreshed by the feed's
  own sync; a later KicksDB verification wins the row (source flips), while
  feed syncs never overwrite a `kicksdb` row.

Entries never leave. Every route feeds it: syncs, imports, previews.

Discovery columns (`image`, `min_ask`, `variant_count`, `added_at`) are
denormalized from the stored product at upsert time, so the grid
filters/sorts/paginates in SQL.

## Tabs

- **Catalog** (`/catalog`) — discovery: brand sidebar with counts, debounced
  search, freshness/price filters, six sorts, paged grid. All state in the URL.
  Clicking a card opens the **product drawer** (`?product=<sku>`; full-screen
  sheet on mobile): per-size asks + computed proposed prices, **re-sync from
  KicksDB**, per-size **manual price locks** and the per-product **sale rule**
  (both via `store_overrides`, keyed by SKU/EU size — snapshot-independent, so
  the sync honors them automatically).
- **Sync** (`/sync`) — the main workflow: **align sizes, then patch prices**,
  all over REST:
  1. **Pull**: walk the Woo REST API (`products` incl. attributes + variations)
     into the active store snapshot (`source: "rest"`). Cursor-driven and
     resumable (`store_pull_runs` + staging), sized for thousands of products,
     with live progress and cancel.
  2. **Preview**: the plan engine (`buildPlan`) matches StockX variants to Woo
     variations GTIN-first then by EU size, prices them through the scoped
     rules, and shows the per-variant diff (update / create / noop / skip).
  3. **Apply** — two passes per product, dry-run first (live apply unlocks only
     after a dry run of the same selection + cleanup scope):
     - **Size cleanup** (default on): the sanitize engine plans REST
       operations — DELETE orphan/ghost/duplicate variations that don't align
       with `pa_taglia` (so Woo never shows them), rewrite survivors with the
       realigned `attribute_pa_taglia`, make zero-stock sizes carried by
       KicksDB available, and PUT the parent's realigned option list. Only
       previewed products are ever touched.
     - **Prices**: the selected `update` rows via
       `products/{id}/variations/batch` (a price aimed at a deleted duplicate
       is dropped — its surviving twin carries its own row).
     Every run lands in `apply_audit`; after a live run the stored snapshot is
     patched to the post-apply state, so the next preview reflects reality
     without a re-pull.
- **Import** (`/import`) — manual textarea or CSV/TXT/TSV upload. SKUs are
  extracted, chunked, GET-verified and upserted through the same pipeline;
  each operator action is one `ingestion_runs` row (added / known / rejected).
- **Feeds** (`/feeds`) — the ingestion-source registry. Built-in feed:
  **KicksDB refresh**, which re-prices the stalest entries via the bulk
  endpoint (50 SKUs/call), merging fresh offers onto stored products. And
  **GoldenSneakers**: the supplier's flat assortment (API pull with bearer
  token + DRF pagination, or manual JSON upload), stored in `feed_items`
  with scs-b2b semantics — validate everything first, abort on empty,
  deactivate-never-delete. **Product-level ownership**: a SKU covered by the
  feed is *owned* by GoldenSneakers — its variant set, final prices
  (`presented_price`, VAT/markup applied upstream via the feed URL params —
  a source-scoped passthrough rule pipes it through the engine unchanged)
  and real stock quantities all come from the feed; KicksDB sizes are
  dropped by design. A manual per-product pin (`store_overrides`) can hand
  a product back to KicksDB. The catalog stays KicksDB-pure.
- *(hidden)* `/preview` — the legacy **file round-trip** flow (upload a Woo
  export, preview, download a patched re-import JSON with sanitize folded in).
  Fully functional, just unlinked — the fallback if REST must be reversed. It
  shares the same sanitize engine as the REST cleanup
  (`src/server/store-json/sanitize.ts`), so file and live cleanup can never
  disagree.

## Scheduled runs

Two authenticated cron endpoints (set `CRON_SECRET`, then hit them from any
scheduler):

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/pull-store       # full Woo pull
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/refresh-catalog  # re-price stale entries
```

## Core

- `core/core-spine.ts`, `core/config.ts` — domain model, pricing engine
  (`computePrice`/`resolveEffectiveRule`), plan/diff (`buildPlan`), the
  `SourcePort` seam, and the `WooStoreAdapter` skeleton behind the REST apply.
- `src/server/woo/` — the live Woo REST client, the resumable pull, the
  audited apply.
- `src/server/store-json/` — the store-state model (one shape, two transports:
  REST pull or file upload), EU-size matching, and the file-export patch path.

## Pricing config

KicksDB returns **raw lowest asks** — every markup is applied by this app
(`computePrice`: ask → markup → floor → optional VAT → rounding). The default
rule (`src/server/config/defaults.ts`) uses a **dynamic, price-banded markup**
on the raw ask: ≤150€ → 35%, ≤300€ → 30%, ≤500€ → 25%, above → 19%, with
charm `.99` rounding. The band is the **total shelf uplift**: VAT is
considered included in the resulting price, never stacked on top (€100 ask →
€135.99, not €135 × 1.22). Setting a VAT rate in the pricing editor
re-enables the add-on-top behaviour explicitly. Band selection happens on the
ask, so the retail price never shifts its own band.

The **Pricing** bar (on `/sync` and `/preview`) shows the live bands and the
store-wide **Reprice discounted** switch, and hosts the editor: saving a flat
markup there switches banding off; **Reset** restores the banded defaults.
After upgrading an existing DB, press **Reset** once — the stored config row
still carries the old flat rule. Precedence for any variant price:
**manual lock > sale rule > computed price**.

## Caching

Two independent best-effort layers (an outage degrades to a live fetch, never a
hard failure): the Redis TTL cache (`src/server/cache/`) for query results, and
the persistent catalog itself — the smart cache in front of every SKU lookup.

## Scripts

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest (pricing/plan/match/patch core)
npm run guard:tanstack
npm run db:generate   # drizzle migration from schema
npm run build
```
